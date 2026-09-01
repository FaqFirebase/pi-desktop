import { ChildProcess, SpawnOptions, spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type {
  AgentEngineKind,
  PiRpcEvent,
  PiStartOptions,
  PiProcessStatus,
  PiStartupPhase,
  PiStatus,
  PiResponseEvent,
  AgentInstallation,
} from '../shared/ipc-contracts'
import type { CaptureOptions, PiEngine, PiResolution, ResolutionDeps } from './pi-binary-resolution'
import {
  describePiResolutionFailure,
  isOmpExecutable,
  normalizeOverride,
  resolvePiBinary,
  whichInPath,
} from './pi-binary-resolution'
import { escapeCmdSpawn } from './cmd-escape'
import { appLog } from './app-log'
import { getGuiDataPath } from './app-data-paths'

/**
 * Manages a Pi RPC child process.
 *
 * Responsibilities:
 * - Spawn/kill Pi in --mode rpc
 * - Parse JSONL from stdout (LF-delimited, no Unicode line separators)
 * - Route events to subscribers
 * - Correlate request/response via id field
 * - Handle extension UI request/response sub-protocol
 */

const JSONL_NEWLINE = '\n'
const RPC_MODE = 'rpc'
const NO_SESSION_FLAG = '--no-session'
const MODE_FLAG = '--mode'
const PROVIDER_FLAG = '--provider'
const MODEL_FLAG = '--model'
const SESSION_FLAG = '--session'
const FORK_FLAG = '--fork'
const CONTINUE_FLAG = '--continue'
const IS_WINDOWS = process.platform === 'win32'
const MS_PER_SECOND = 1_000
// The startup deadline is two-staged (issue #58). Stage 1: while Pi has
// printed nothing at all, give up quickly — a dead spawn or a broken stdio
// pipe stays silent forever. Stage 2: once stdout has shown life the process
// is provably alive and piped, so the deadline stretches: the engine runs
// every extension session_start hook BEFORE it reads stdin, and a hook that
// calls a local model server can sit through tens of seconds of prompt
// prefill while our readiness probe waits unread.
const STARTUP_SILENCE_TIMEOUT_MS = 20_000
const STARTUP_ENGINE_BUSY_TIMEOUT_MS = 120_000

/** Startup deadline caps, injectable so tests do not wait out real minutes. */
export interface PiStartupTimeouts {
  /** Max wait for the first byte of Pi stdout. */
  silenceMs: number
  /** Max wait for readiness once stdout has shown life. */
  engineBusyMs: number
}
// Spawn attempts per start(): the initial try plus one retry, used ONLY when Pi
// crashes before becoming ready (spawn error / early exit) — a transient hiccup
// (AV lock, momentary ENOENT) often clears on a second spawn. A no-response
// timeout is not retried: respawning would just burn another full timeout.
const STARTUP_MAX_ATTEMPTS = 2
// Pi's RPC mode emits nothing on connect — it only replies to requests. So
// instead of a blind settle wait, we send a cheap read-only probe after spawn
// and treat its CORRELATED response (matched by STARTUP_PROBE_ID in handleLine,
// success OR error) as "ready". Keying off the correlated response — not merely
// the first stdout byte — confirms the request→response loop works and stays
// robust even if the probe command is renamed (Pi echoes our id on an "unknown
// command" error too). The probe is resent on this interval in case the first
// write raced Pi's stdin reader; the two-stage startup deadline (see
// PiStartupTimeouts above) bounds the wait.
const STARTUP_PROBE_ID = '__startup_probe__'
// get_state is the cheapest liveness command: a handful of in-memory session
// field reads — no I/O, no model/provider calls, O(1). (get_session_stats is
// O(messages) and get_available_models filters the model list.)
const STARTUP_PROBE_COMMAND = 'get_state'
const STARTUP_PROBE_INTERVAL_MS = 750
const FORCE_KILL_TIMEOUT_MS = 3_000
/** Bound on the one `ps` call used to snapshot a child's descendants at kill time. */
const PROCESS_TREE_TIMEOUT_MS = 2_000
/**
 * Fallbacks only. The engine advertises its real limits in the `ready` frame
 * (`maxFrameBytes`, `maxReassembledFrameBytes`); configureLimits() adopts those
 * so the receiver never enforces a stricter rule than the sender obeys. These
 * defaults match what OMP 18 advertises and are used until `ready` arrives, and
 * for the original Pi RPC implementation, which sends no ready frame.
 */
const RPC_DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024
const RPC_DEFAULT_MAX_CHUNK_PAYLOAD_BYTES = 1024 * 1024
/** Chunking only exists for frames a single line cannot carry. */
const RPC_MIN_CHUNK_COUNT = 2
const RPC_MAX_CHUNK_ID_LENGTH = 128
/**
 * Standard base64 with the padding the sender's encoder emits. The alphabet
 * and the padding shape are enforced here; the round-trip re-encode in push()
 * additionally rejects non-canonical trailing bits (`QR==` and `QQ==` both
 * decode to one byte, only the latter is what an encoder produces), so one
 * payload has exactly one legal wire spelling. Base64url and unpadded input
 * are rejected by this pattern, not by the round-trip — the two checks state
 * the same policy and are loosened or kept together.
 */
const RPC_CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

interface PendingRpcChunks {
  chunkId: string
  count: number
  byteLength: number
  nextIndex: number
  chunks: Buffer[]
  receivedBytes: number
}

function isRpcChunkFrame(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'rpc_chunk'
}

/** Minimal lossless decoder for OMP RPC protocol v2 physical frames. */
export class RpcFrameDecoder {
  private pending: PendingRpcChunks | null = null
  private maxReassembledBytes = RPC_DEFAULT_MAX_REASSEMBLED_BYTES
  private maxChunkPayloadBytes = RPC_DEFAULT_MAX_CHUNK_PAYLOAD_BYTES

  hasPending(): boolean {
    return this.pending !== null
  }

  reset(): void {
    this.pending = null
  }

  /**
   * Adopt the limits the engine advertised in its `ready` frame. A sender only
   * chunks what exceeds its own single-frame cap, so that cap is also the
   * largest payload any one chunk can carry. Ignores absent or nonsensical
   * values so a malformed ready frame cannot widen or break the decoder.
   */
  configureLimits(limits: { maxFrameBytes?: unknown; maxReassembledFrameBytes?: unknown }): void {
    const frame = limits.maxFrameBytes
    const reassembled = limits.maxReassembledFrameBytes
    if (typeof frame === 'number' && Number.isSafeInteger(frame) && frame > 0) {
      this.maxChunkPayloadBytes = frame
    }
    if (typeof reassembled === 'number' && Number.isSafeInteger(reassembled) && reassembled > 0) {
      this.maxReassembledBytes = reassembled
    }
  }

  push(value: Record<string, unknown>): object | undefined {
    const chunkId = value.chunkId
    const index = typeof value.index === 'number' ? value.index : Number.NaN
    const count = typeof value.count === 'number' ? value.count : Number.NaN
    const byteLength = typeof value.byteLength === 'number' ? value.byteLength : Number.NaN
    const data = value.data
    // `byteLength` is bounded above only. How the sender splits a frame is its
    // own business, so there is no floor: a floor of one whole frame would make
    // every short chunk sequence undecodable if the sender ever lowered its
    // frame cap. A wrong declared length is still caught while reassembling,
    // against the bytes actually received.
    const maxChunkCount = Math.ceil(this.maxReassembledBytes / this.maxChunkPayloadBytes)
    if (
      typeof chunkId !== 'string' || chunkId.length === 0 || chunkId.length > RPC_MAX_CHUNK_ID_LENGTH ||
      !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) ||
      index < 0 || count < RPC_MIN_CHUNK_COUNT || count > maxChunkCount || index >= count ||
      byteLength <= 0 || byteLength > this.maxReassembledBytes ||
      typeof data !== 'string' || data.length === 0 || !RPC_CANONICAL_BASE64.test(data)
    ) {
      throw new Error('invalid rpc chunk metadata')
    }
    const chunkIndex = index as number
    const chunkCount = count as number
    const declaredByteLength = byteLength as number
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data || bytes.byteLength > this.maxChunkPayloadBytes) {
      throw new Error('invalid rpc chunk data')
    }

    if (!this.pending) {
      if (chunkIndex !== 0) throw new Error('rpc chunk sequence must start at index 0')
      this.pending = { chunkId, count: chunkCount, byteLength: declaredByteLength, nextIndex: 0, chunks: [], receivedBytes: 0 }
    }
    const pending = this.pending!
    if (
      pending.chunkId !== chunkId || pending.count !== chunkCount || pending.byteLength !== declaredByteLength ||
      pending.nextIndex !== chunkIndex
    ) {
      throw new Error('rpc chunk sequence mismatch')
    }
    pending.chunks.push(bytes)
    pending.receivedBytes += bytes.byteLength
    pending.nextIndex++
    if (pending.receivedBytes > pending.byteLength) throw new Error('rpc chunk sequence exceeds declared length')
    if (pending.nextIndex < pending.count) return undefined
    if (pending.receivedBytes !== pending.byteLength) throw new Error('rpc chunk sequence length mismatch')

    this.pending = null
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.chunks))
    const frame = JSON.parse(decoded) as unknown
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) throw new Error('rpc frame must be an object')
    return frame as object
  }
}

// Real filesystem/process access for the resolver in pi-binary-resolution.ts.
// Kept in one object so the search order stays testable against a fake.
const RESOLUTION_DEPS: ResolutionDeps = {
  isWindows: IS_WINDOWS,
  env: process.env,
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch (err) {
      // ENOENT/EACCES/ELOOP all mean "not a directory we can use".
      if (isFsAccessError(err)) return false
      throw err
    }
  },
  listDir: (path) => {
    try {
      return readdirSync(path)
    } catch (err) {
      if (isFsAccessError(err)) return []
      throw err
    }
  },
  capture: (command, args, options) => runCapture(command, args, options),
}

const FS_ACCESS_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'])

function isFsAccessError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && FS_ACCESS_ERROR_CODES.has(code)
}

/**
 * Run a probe command and return its stdout, or null if it could not run.
 * stdin is closed immediately so an interactive login shell never blocks.
 */
function runCapture(command: string, args: string[], options: CaptureOptions): string | null {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf-8',
      shell: options.shell,
      timeout: options.timeoutMs,
      input: '',
      env: { ...process.env, PATH: options.pathEnv },
    })
    if (result.status !== 0 || !result.stdout) return null
    return result.stdout
  } catch (err) {
    // Spawn-level failure (missing binary, EACCES) — treat as "no answer".
    if (isFsAccessError(err)) return null
    throw err
  }
}

/**
 * Find a Node binary to run the Pi .js script with. Searches NODE env,
 * npm_node_execpath (set when running under npm), Electron's own process,
 * common install paths, and PATH.
 */
function findNodeBinary(): string {
  if (process.env.NODE && existsSync(process.env.NODE)) return process.env.NODE
  if (process.env.npm_node_execpath && existsSync(process.env.npm_node_execpath)) {
    return process.env.npm_node_execpath
  }

  if (IS_WINDOWS) {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const candidates = [
      // Pi's install.ps1 puts an auto-installed Node under
      // %LOCALAPPDATA%\pi-node\current\node.exe. Check the symlinked
      // 'current' path first; fall back to the bare pi-node dir for
      // older layouts.
      localAppData ? join(localAppData, 'pi-node', 'current', 'node.exe') : '',
      localAppData ? join(localAppData, 'pi-node', 'node.exe') : '',
      join(programFiles, 'nodejs', 'node.exe'),
      join(programFilesX86, 'nodejs', 'node.exe'),
      localAppData ? join(localAppData, 'fnm_multishells', 'node.exe') : '',
    ].filter(Boolean)
    for (const c of candidates) if (existsSync(c)) return c
    const fromPath = whichInPath(RESOLUTION_DEPS, 'node', process.env.PATH ?? '')
    if (fromPath) return fromPath
    return 'node.exe'
  }

  for (const c of ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    if (existsSync(c)) return c
  }
  const fromPath = whichInPath(RESOLUTION_DEPS, 'node', process.env.PATH ?? '')
  if (fromPath) return fromPath
  return 'node'
}

/**
 * Resolved Pi invocation. `found` is false when nothing was located and
 * `script` is only a hopeful fallback; `failureReason` then explains why.
 */
export interface PiCli {
  /** The selected engine. OMP deliberately keeps the Pi-compatible RPC path. */
  kind?: 'pi' | 'omp'
  script: string
  node: string
  useNode: boolean
  needsShell: boolean
  found: boolean
  nodeFound: boolean
  failureReason: string | null
}

// Resolution is lazy and cached rather than computed at import time, because
// it depends on the executable path and explicit engine setting, which are only
// readable once app settings have loaded.
let configuredOverride: string | null = null
let configuredEngine: PiEngine = 'auto'
let cachedResolution: PiResolution | null = null
/**
 * Auto-detected resolution per engine, for starts that must run a specific
 * engine rather than the configured one. Cached and invalidated exactly like
 * `cachedResolution` — both read the same filesystem state.
 */
const engineResolutions = new Map<AgentEngineKind, PiResolution>()
let cachedNodeBinary: string | null = null
let detectedInstallationsCache: { at: number; value: AgentInstallation[] } | null = null
/** How long a detection result is served without re-walking the filesystem. */
const INSTALLATION_CACHE_TTL_MS = 30_000
/**
 * Apply the selected executable and engine. The engine is persisted separately
 * so a custom path named something other than `omp` cannot silently change the
 * protocol/tool surface.
 */
export function setPiExecutableOverride(raw: string | undefined | null, engine: PiEngine = 'auto'): void {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const next = normalizeOverride(raw, home)
  if (next === configuredOverride && engine === configuredEngine && cachedResolution) return
  configuredOverride = next
  configuredEngine = engine
  cachedResolution = null
  engineResolutions.clear()
  cachedNodeBinary = null
}


function getResolution(): PiResolution {
  if (cachedResolution) return cachedResolution
  const resolution = resolvePiBinary(RESOLUTION_DEPS, configuredOverride, configuredEngine)
  // Adopt the login shell's PATH process-wide so Pi itself — and every helper
  // we spawn — can find node, npm and the tools the user's shell exposes.
  if (resolution.pathEnv && resolution.pathEnv !== process.env.PATH) {
    process.env.PATH = resolution.pathEnv
  }
  cachedResolution = resolution
  logResolution(resolution)
  return resolution
}

/**
 * Full resolution details (source, PATH, rejected override) for the
 * diagnostics report. First call may run the login-shell and npm probes.
 */
export function getPiResolution(): PiResolution {
  return getResolution()
}

/**
 * Detect the first usable installation for each supported engine.
 *
 * `force` skips the cache. A rescan is the user telling us the filesystem
 * changed since the last look — serving a cached answer there turns the
 * Rescan button into a spinner that can never report a new install.
 */
export function detectPiInstallations(force = false): AgentInstallation[] {
  const cached = detectedInstallationsCache
  if (!force && cached && Date.now() - cached.at < INSTALLATION_CACHE_TTL_MS) {
    return cached.value.map((item) => ({ ...item }))
  }
  const candidates: Array<{ kind: AgentInstallation['kind']; resolution: PiResolution }> = [
    { kind: 'pi', resolution: resolvePiBinary(RESOLUTION_DEPS, null, 'pi') },
    { kind: 'omp', resolution: resolvePiBinary(RESOLUTION_DEPS, null, 'omp') },
  ]
  const seen = new Set<string>()
  const value = candidates.flatMap(({ kind, resolution }) => {
    if (!resolution.found) return []
    const key = resolution.script.toLowerCase()
    if (seen.has(key)) return []
    seen.add(key)
    return [{ kind, path: resolution.script, source: resolution.source }]
  })
  detectedInstallationsCache = { at: Date.now(), value }
  return value.map((item) => ({ ...item }))
}

function logResolution(resolution: PiResolution): void {
  const node = getNodeBinary()
  console.log('─── Pi binary resolution ────────────────────────────')
  console.log('[Pi] Script        :', resolution.script, resolution.found ? '(exists)' : '(MISSING)')
  console.log('[Pi] Source        :', resolution.source)
  if (resolution.rejectedOverride) {
    console.warn('[Pi] Configured path ignored (does not exist):', resolution.rejectedOverride)
  }
  console.log('[Pi] Uses node     :', resolution.useNode)
  console.log(
    '[Pi] Node binary   :',
    node,
    resolution.useNode ? (existsSync(node) ? '(exists)' : '(MISSING)') : '(unused)'
  )
  console.log('[Pi] Needs shell   :', resolution.needsShell)
  console.log('─────────────────────────────────────────────────────')
}

function getNodeBinary(): string {
  if (cachedNodeBinary === null) cachedNodeBinary = findNodeBinary()
  return cachedNodeBinary
}

/** Pair a resolution with the Node binary and the failure text spawn needs. */
function toPiCli(resolution: PiResolution, kind: AgentEngineKind): PiCli {
  const node = getNodeBinary()
  const nodeFound = !resolution.useNode || existsSync(node)
  let failureReason: string | null = null
  if (!resolution.found) {
    failureReason = describePiResolutionFailure(resolution)
  } else if (!nodeFound) {
    failureReason =
      `Node binary not found at resolved path:\n  ${node}\n\n` +
      "Pi's .js entry point requires Node. Install Node from https://nodejs.org " +
      'or set the NODE env var to your Node binary path.'
  }
  return {
    kind,
    script: resolution.script,
    node,
    useNode: resolution.useNode,
    needsShell: resolution.needsShell,
    found: resolution.found,
    nodeFound,
    failureReason,
  }
}

/**
 * The resolved Pi invocation. Also exported for ipc-handlers, which runs
 * `pi install/remove/update` with the same binary — Electron's own PATH won't
 * have `pi` on it.
 */
export function getPiCli(): PiCli {
  const resolution = getResolution()
  return toPiCli(
    resolution,
    configuredEngine === 'omp'
      ? 'omp'
      : configuredEngine === 'pi'
        ? 'pi'
        : isOmpExecutable(resolution.script) ? 'omp' : 'pi'
  )
}

/**
 * The engine a start would use right now. Needed wherever the status of "no
 * process yet" has to be reported: the window opens before anything is
 * spawned, and a status with no engine reads as Pi, so the status bar named
 * the wrong CLI until the first agent started.
 */
export function getConfiguredEngineKind(): AgentEngineKind {
  return getPiCli().kind ?? 'pi'
}

/**
 * The invocation for one named engine, whatever the configured default is.
 *
 * The engine is a PARAMETER here instead of a temporary write to
 * `configuredEngine`: session runtimes start concurrently, so a global the
 * caller flips before each spawn would let one session's engine leak into
 * another session's start — the exact race a per-session engine has to avoid.
 * Each engine's resolution is cached under its own key and cleared with the
 * configured one.
 */
export function getPiCliForEngine(engine: AgentEngineKind): PiCli {
  const configured = getPiCli()
  // The configured resolution already targets this engine, including any
  // executable path the user set for it.
  if (configured.kind === engine) return configured
  // A configured override names the OTHER engine's binary, so this engine is
  // auto-detected rather than inheriting a path that is not its own.
  const cached = engineResolutions.get(engine)
  if (cached) return toPiCli(cached, engine)
  const resolution = resolvePiBinary(RESOLUTION_DEPS, null, engine)
  // Only a hit is remembered. Caching "not installed" would keep answering
  // that after the user installs the engine, for the whole run.
  if (resolution.found) engineResolutions.set(engine, resolution)
  return toPiCli(resolution, engine)
}

/**
 * The CLI one start() spawns. `options.engine` names the engine that owns the
 * session being opened and outranks the configured default, so a Pi session
 * always resumes under Pi and an OMP session under OMP.
 */
export function resolveStartCli(options: PiStartOptions): PiCli {
  if (!options.engine) return getPiCli()
  const owner = getPiCliForEngine(options.engine)
  if (owner.found) return owner
  // The owning engine is not installed. Both engines write the same JSONL, so
  // opening the conversation with the configured engine beats refusing to open
  // it at all; getEngineKind then reports what actually runs.
  appLog.warn(
    'pi',
    `Session engine ${options.engine} is not installed; starting the configured engine instead`
  )
  return getPiCli()
}

/**
 * The argv for one RPC start, engine-independent.
 *
 * No `--session-dir` is injected: each engine keeps its sessions in its own
 * default store and the index reads both. Forcing OMP at Pi's root only ever
 * moved resumed sessions, because OMP ignores the flag for new ones, which
 * split one conversation history across two trees. A caller that really wants
 * a shared store passes `--session-dir` in `options.args`, and it survives —
 * caller args are appended verbatim.
 */
export function buildPiArgs(options: PiStartOptions): string[] {
  const args: string[] = [MODE_FLAG, RPC_MODE]

  if (options.noSession) {
    args.push(NO_SESSION_FLAG)
  }

  if (options.provider) {
    args.push(PROVIDER_FLAG, options.provider)
  }

  if (options.model) {
    args.push(MODEL_FLAG, options.model)
  }

  if (options.forkSessionPath) {
    args.push(FORK_FLAG, options.forkSessionPath)
  } else if (options.sessionPath) {
    // Both engines honour an explicit session path, which is what lets a
    // session be resumed out of the store its own engine owns.
    args.push(SESSION_FLAG, options.sessionPath)
  } else if (options.continueSession && !options.noSession) {
    // Resume the most recent session for the cwd. Pi falls back to a fresh
    // session when none exists, so this is safe on first run.
    args.push(CONTINUE_FLAG)
  }

  if (options.args) {
    args.push(...options.args)
  }

  return args
}

/**
 * The exact program and argv for one Pi invocation, ready for spawn().
 *
 * `useNode` runs Pi's .js entry point through Node, which never needs a shell,
 * so both paths stay byte-identical there and on POSIX. A direct spawn of a
 * Windows `.cmd`/`.bat` shim does need shell:true (Node refuses to launch one
 * otherwise since CVE-2024-27980) and Node performs no quoting on that path,
 * so the script path — which reaches us through the user profile directory and
 * can hold spaces or cmd metacharacters — and every argument are escaped for
 * the cmd.exe traversal. Throws on characters cmd.exe cannot carry at all.
 */
export function buildPiInvocation(
  cli: PiCli,
  args: readonly string[],
): { file: string; args: string[] } {
  return cli.useNode
    ? escapeCmdSpawn(cli.needsShell, cli.node, [cli.script, ...args])
    : escapeCmdSpawn(cli.needsShell, cli.script, args)
}

const MAX_PENDING_RESPONSES = 64
const RESPONSE_TIMEOUT_MS = 30_000

/**
 * Writable temp directory for the Pi child process on Windows only. Prefer the
 * GUI data dir so extensions (pi-subagents, etc.) don't depend on a locked
 * %TEMP% tree. Not used on POSIX — those platforms keep the system temp so
 * $TMPDIR still receives OS cleanup.
 */
function resolvePiChildTempDir(): string {
  try {
    const dir = getGuiDataPath('tmp')
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    // Fall back to home — still more reliable than a broken Local\Temp ACL.
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
    const dir = join(home, '.pi', 'tmp')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // Last resort: leave system TEMP as-is via process.env
    }
    return dir
  }
}

/** Windows-only TEMP/TMP/TMPDIR override for the Pi child. Empty on other OSes. */
function buildPiChildEnv(): NodeJS.ProcessEnv {
  if (!IS_WINDOWS) return {}
  const tmp = resolvePiChildTempDir()
  return {
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
  }
}

/**
 * Best-effort wipe of the GUI-owned Pi temp dir (Windows). Called on app quit
 * so pi-subagents / extension scratch does not grow without bound.
 */
export function cleanupPiChildTempDir(): void {
  if (!IS_WINDOWS) return
  try {
    const dir = getGuiDataPath('tmp')
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      try {
        rmSync(join(dir, name), { recursive: true, force: true })
      } catch {
        // In use or locked — leave for next quit.
      }
    }
  } catch {
    // Ignore — quit path must not throw.
  }
}

interface PendingResponse {
  resolve: (event: PiResponseEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PiRpcManager extends EventEmitter {
  private process: ChildProcess | null = null
  private status: PiProcessStatus = 'stopped'
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private pendingResponses = new Map<string, PendingResponse>()
  private nextRequestId = 1
  private decoder = new StringDecoder('utf8')
  private rpcFrameDecoder = new RpcFrameDecoder()
  private startInFlight: Promise<PiStatus> | null = null
  private runningEngine: 'pi' | 'omp' | null = null
  private readonly exitWaiters = new Map<ChildProcess, Set<() => void>>()
  // Set while a spawn attempt awaits readiness; handleLine invokes it when the
  // startup probe's correlated response arrives. Cleared once the attempt settles.
  private markReady: (() => void) | null = null
  // Settles a pending startup attempt when the process is torn down under it.
  // Without this, stop()/restart() during 'starting' would sever every settle
  // path of spawnAndAwaitReady (kill() removes the child's listeners and the
  // deadline guard is status-gated), leaving start() hung forever.
  private abortStartup: (() => void) | null = null
  // Set on the first stdout byte of the current spawn attempt; decides which
  // startup deadline applies and which timeout error is reported.
  private startupSawOutput = false
  // Non-null only while a spawn attempt is in flight (see PiStartupPhase).
  private startupPhase: PiStartupPhase | null = null
  private readonly startupTimeouts: PiStartupTimeouts

  constructor(startupTimeouts?: Partial<PiStartupTimeouts>) {
    super()
    this.startupTimeouts = {
      silenceMs: startupTimeouts?.silenceMs ?? STARTUP_SILENCE_TIMEOUT_MS,
      engineBusyMs: startupTimeouts?.engineBusyMs ?? STARTUP_ENGINE_BUSY_TIMEOUT_MS,
    }
  }

  getStatus(): PiStatus {
    return {
      status: this.status,
      pid: this.process?.pid ?? null,
      // Only report captured stderr as an error when we're actually in the
      // 'error' state. Pi and its extensions (e.g. pi-ollama) log benign,
      // informational lines to stderr while running — surfacing those as an
      // error misleads the UI into showing healthy startup logs as ERROR.
      error: this.status === 'error' ? (this.stderrBuffer || null) : null,
      engine: this.getEngineKind(),
      // Written even when unset (as undefined) so spread-merges of successive
      // snapshots (e.g. SessionRuntimeInfo) cannot carry a stale phase along.
      startupPhase: this.startupPhase ?? undefined,
    }
  }
  /** Engine identity of the live child, not the currently configured future one. */
  getEngineKind(): AgentEngineKind {
    return this.runningEngine ?? getConfiguredEngineKind()
  }

  async start(options: PiStartOptions = {}): Promise<PiStatus> {
    if (this.status === 'running') {
      return this.getStatus()
    }
    // Coalesce concurrent starts during the 'starting' window so we never
    // spawn duplicate child processes when two callers race.
    if (this.startInFlight) {
      return this.startInFlight
    }

    this.startInFlight = this.doStart(options).finally(() => {
      this.startInFlight = null
    })
    return this.startInFlight
  }

  private async doStart(options: PiStartOptions): Promise<PiStatus> {
    this.kill()
    this.setStatus('starting')
    this.stderrBuffer = ''

    // Pre-flight: if the binary we resolved doesn't exist, fail fast with a
    // clear message instead of letting spawn die with a cryptic ENOENT.
    const cli = resolveStartCli(options)
    if (cli.failureReason) {
      this.stderrBuffer = cli.failureReason
      this.setStatus('error')
      console.error('[Pi] Pre-flight failed:', this.stderrBuffer)
      appLog.error('pi', 'Pre-flight failed', this.stderrBuffer)
      return this.getStatus()
    }
    if (options.cwd && (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory())) {
      this.stderrBuffer = `Pi working directory does not exist or is not a directory:\n  ${options.cwd}`
      this.setStatus('error')
      console.error('[Pi] Pre-flight failed:', this.stderrBuffer)
      appLog.error('pi', 'Pre-flight failed', this.stderrBuffer)
      return this.getStatus()
    }

    // Spawn, with one retry reserved for a crash before readiness. See
    // STARTUP_MAX_ATTEMPTS: a crash is often transient; a timeout is not.
    for (let attempt = 1; attempt <= STARTUP_MAX_ATTEMPTS; attempt++) {
      const outcome = await this.spawnAndAwaitReady(options)
      if (outcome === 'ready') return this.getStatus()

      // A deliberate stop/restart tore this attempt down; the initiator has
      // already set the status — report it without retrying or erroring.
      if (outcome === 'aborted') return this.getStatus()

      if (outcome === 'crashed' && attempt < STARTUP_MAX_ATTEMPTS) {
        console.log(
          `[Pi] Startup crashed before ready (attempt ${attempt}/${STARTUP_MAX_ATTEMPTS}); retrying once…`
        )
        this.kill()
        this.setStatus('starting')
        continue
      }

      // Terminal failure — surface a useful error. kill() reaps any hung
      // process; it clears stdout but leaves stderrBuffer intact, so the
      // captured reason survives.
      const captured = this.stderrBuffer.trim()
      this.kill()
      this.setStatus('error')
      this.stderrBuffer =
        outcome === 'timeout'
          ? this.describeStartupTimeout(captured)
          : captured || 'Pi crashed before becoming ready.'
      return this.getStatus()
    }

    // Unreachable — the loop always returns — but satisfies the type checker.
    return this.getStatus()
  }

  /**
   * The user-facing reason for a startup timeout. Names only what the streams
   * proved — never guesses at causes the evidence rules out (the old fixed
   * message misdiagnosed issue #58 for days).
   */
  private describeStartupTimeout(captured: string): string {
    if (this.startupSawOutput) {
      return (
        `Pi started but did not become ready within ${this.startupTimeouts.engineBusyMs / MS_PER_SECOND}s.\n\n` +
        'Pi was alive and producing output, but never answered the readiness check. ' +
        'Extension startup hooks run before Pi reads commands, and a hook that calls a ' +
        'local model server can wait this long while the model loads or prefills a large prompt. ' +
        'Check the engine and model-server logs, then retry.' +
        (captured ? `\n\nPi stderr captured during startup:\n${captured}` : '')
      )
    }
    return (
      `Pi produced no output within ${this.startupTimeouts.silenceMs / MS_PER_SECOND}s.\n\n` +
      (captured
        ? `Pi stderr captured during startup:\n${captured}`
        : 'No output captured. Check the app log for the exact spawn command, and try running `pi --mode rpc` directly in a terminal.')
    )
  }

  /**
   * Spawn one Pi process and wait for it to become RPC-ready. Resolves:
   *  - 'ready'   — the readiness probe's correlated response arrived; status is
   *                now 'running'.
   *  - 'crashed' — spawn error, or the process exited before becoming ready.
   *  - 'timeout' — no response within the applicable startup deadline:
   *                silenceMs while stdout stayed silent, engineBusyMs once
   *                output proved the process alive (see PiStartupTimeouts).
   * It does NOT set the terminal 'error' status — doStart owns that, so it can
   * retry a crash without flipping the UI to 'error' between attempts.
   */
  private spawnAndAwaitReady(
    options: PiStartOptions
  ): Promise<'ready' | 'crashed' | 'timeout' | 'aborted'> {
    const args = buildPiArgs(options)
    const cli = resolveStartCli(options)

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      // Windows only: redirect TEMP so pi-subagents can mkdir without EPERM on
      // locked %LocalAppData%\Temp trees. POSIX keeps the system temp (OS cleanup).
      env: { ...process.env, ...buildPiChildEnv(), ...options.env },
      // .cmd/.bat/.ps1 shims on Windows can't be invoked directly from
      // spawn — they need the cmd.exe interpreter via shell:true.
      shell: cli.needsShell,
      // On POSIX, make the child its own process-group leader so kill()'s
      // negative-PID group kill reaps Pi and all its descendants. Skipped on
      // Windows, where it would spawn a detached console window with shell:true.
      detached: !IS_WINDOWS,
    }

    let proc: ChildProcess
    try {
      // Escaping happens inside the try so a path or argument cmd.exe cannot
      // carry fails this attempt like any other spawn failure ('crashed'),
      // instead of throwing out of start().
      const invocation = buildPiInvocation(cli, args)
      console.log('[Pi] Spawning with cwd:', options.cwd)
      console.log('[Pi] Spawn argv     :', [invocation.file, ...invocation.args])
      proc = spawn(invocation.file, invocation.args, spawnOptions)
    } catch (err) {
      this.stderrBuffer += (err instanceof Error ? err.message : String(err)) + '\n'
      return Promise.resolve('crashed')
    }
    this.process = proc
    this.runningEngine = cli.kind ?? 'pi'
    this.startupSawOutput = false
    this.startupPhase = 'spawning'
    this.setupStreams()

    return new Promise<'ready' | 'crashed' | 'timeout' | 'aborted'>((resolve) => {
      let settled = false
      let probeTimer: NodeJS.Timeout | null = null
      let silenceTimer: NodeJS.Timeout | null = null
      let engineBusyTimer: NodeJS.Timeout | null = null
      const startedAt = Date.now()
      const finish = (outcome: 'ready' | 'crashed' | 'timeout' | 'aborted'): void => {
        if (settled) return
        settled = true
        this.markReady = null
        this.abortStartup = null
        this.startupPhase = null
        if (probeTimer) {
          clearInterval(probeTimer)
          probeTimer = null
        }
        if (silenceTimer) {
          clearTimeout(silenceTimer)
          silenceTimer = null
        }
        if (engineBusyTimer) {
          clearTimeout(engineBusyTimer)
          engineBusyTimer = null
        }
        resolve(outcome)
      }
      // Deliberate teardown (stop/restart) while starting: settle without
      // retrying and without stamping an error — the caller chose to stop.
      this.abortStartup = (): void => finish('aborted')

      // Readiness signal: handleLine invokes this when the probe's correlated
      // response (success OR "unknown command" error) arrives — proof the
      // request→response loop is live.
      this.markReady = (): void => {
        if (this.status === 'starting') {
          console.log(`[Pi] Ready after ${Date.now() - startedAt}ms`)
          this.setStatus('running')
        }
        finish('ready')
      }

      proc.on('error', (err) => {
        console.error('[Pi] Spawn error:', err.message)
        appLog.error('pi', 'Spawn error', err)
        this.stderrBuffer += `Spawn error: ${err.message}\n`
        finish('crashed')
      })

      proc.on('exit', (code, signal) => {
        console.log('[Pi] Process exited with code:', code, 'signal:', signal, 'pid:', proc.pid)
        if (this.status === 'running') {
          // Exited after becoming ready → normal lifecycle stop.
          this.setStatus('stopped')
          this.emit('exit', { code, signal })
          this.rejectAllPending('Pi process exited')
          return
        }
        // Exited before ready → a startup crash (doStart may retry once).
        if (code !== 0 && code !== null) {
          this.stderrBuffer = (this.stderrBuffer || '') + `Pi exited with code ${code} before becoming ready.`
        }
        finish('crashed')
      })

      // Send the readiness probe, resent on an interval in case the first write
      // raced Pi's stdin reader (Pi doesn't read stdin until its session is
      // bound, so early writes just buffer harmlessly until then).
      const sendProbe = (): void => {
        if (this.status !== 'starting') return
        try {
          this.process?.stdin?.write(
            JSON.stringify({ type: STARTUP_PROBE_COMMAND, id: STARTUP_PROBE_ID }) + JSONL_NEWLINE
          )
        } catch {
          // stdin not writable yet / EPIPE — a resend or the exit handler covers it.
        }
      }
      sendProbe()
      probeTimer = setInterval(sendProbe, STARTUP_PROBE_INTERVAL_MS)

      // Hard deadline, in two stages. Silent stdout at the silence cap means a
      // dead spawn or a broken pipe — give up. Output without readiness means
      // the engine is alive but still binding (its extension session_start
      // hooks run before it reads stdin, so our probe sits unread while a hook
      // may wait on a local model server — issue #58): announce the wait and
      // grant the rest of the engine-busy cap.
      silenceTimer = setTimeout(() => {
        if (settled || this.status !== 'starting') return
        if (!this.startupSawOutput) {
          finish('timeout')
          return
        }
        this.startupPhase = 'waiting-on-engine'
        console.log(
          `[Pi] Alive but not ready after ${this.startupTimeouts.silenceMs}ms; ` +
            `waiting up to ${this.startupTimeouts.engineBusyMs}ms for the engine`
        )
        this.emit('startup-phase', this.startupPhase)
        engineBusyTimer = setTimeout(() => {
          if (!settled && this.status === 'starting') {
            finish('timeout')
          }
        }, Math.max(0, this.startupTimeouts.engineBusyMs - this.startupTimeouts.silenceMs))
      }, this.startupTimeouts.silenceMs)
    })
  }

  stop(): void {
    this.kill()
    this.setStatus('stopped')
  }

  /**
   * Stop the child and wait until Windows releases its cwd/handles.
   * Ordinary stop() remains fire-and-forget for UI navigation.
   */
  async stopAndWait(timeoutMs = FORCE_KILL_TIMEOUT_MS + 500): Promise<void> {
    const proc = this.process
    if (!proc) {
      this.stop()
      return
    }
    await new Promise<void>((resolvePromise) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const waiters = this.exitWaiters.get(proc)
        waiters?.delete(finish)
        if (waiters && waiters.size === 0) this.exitWaiters.delete(proc)
        resolvePromise()
      }
      const waiters = this.exitWaiters.get(proc) ?? new Set<() => void>()
      waiters.add(finish)
      this.exitWaiters.set(proc, waiters)
      this.stop()
      if (proc.exitCode !== null || proc.signalCode !== null) finish()
      else timer = setTimeout(finish, timeoutMs)
    })
  }

  restart(options: PiStartOptions = {}): Promise<PiStatus> {
    this.kill()
    return this.start(options)
  }

  /**
   * Send a command to the Pi RPC process.
   * Returns a correlated response if an id is provided.
   */
  async sendCommand(command: Record<string, unknown>): Promise<PiResponseEvent | null> {
    if (!this.process?.stdin || this.status !== 'running') {
      throw new Error('Pi process is not running')
    }

    const id = `req-${this.nextRequestId++}`
    const cmdWithId = { ...command, id }
    const line = JSON.stringify(cmdWithId) + JSONL_NEWLINE

    return new Promise<PiResponseEvent | null>((resolve, reject) => {
      // Check capacity BEFORE allocating a slot so the limit is exact.
      if (this.pendingResponses.size >= MAX_PENDING_RESPONSES) {
        reject(new Error('Too many pending responses'))
        return
      }

      const timer = setTimeout(() => {
        this.pendingResponses.delete(id)
        reject(new Error(`Command ${command.type} timed out after ${RESPONSE_TIMEOUT_MS}ms`))
      }, RESPONSE_TIMEOUT_MS)

      this.pendingResponses.set(id, { resolve, reject, timer })

      this.process!.stdin!.write(line, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pendingResponses.delete(id)
          reject(err)
        }
      })
    })
  }

  /**
   * Send a command without waiting for a correlated response.
   */
  sendCommandFireAndForget(command: Record<string, unknown>): void {
    if (!this.process?.stdin || this.status !== 'running') {
      return // Silently ignore if Pi isn't running
    }

    const line = JSON.stringify(command) + JSONL_NEWLINE
    try {
      this.process.stdin.write(line)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EPIPE') {
        throw err
      }
      // EPIPE means Pi process exited
      this.setStatus('stopped')
    }
  }

  /**
   * Respond to an extension UI request.
   */
  sendExtensionUiResponse(id: string, response: Record<string, unknown>): void {
    this.sendCommandFireAndForget({
      type: 'extension_ui_response',
      id,
      ...response,
    })
  }

  private setupStreams(): void {
    if (!this.process) return

    // stdout: JSONL events
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.startupSawOutput = true
      this.stdoutBuffer += this.decoder.write(chunk)

      while (true) {
        const newlineIndex = this.stdoutBuffer.indexOf('\n')
        if (newlineIndex === -1) break

        let line = this.stdoutBuffer.slice(0, newlineIndex)
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)

        // Strip optional \r
        if (line.endsWith('\r')) {
          line = line.slice(0, -1)
        }

        if (line.length > 0) {
          this.handleLine(line)
        }
      }
    })

    this.process.stdout?.on('end', () => {
      this.stdoutBuffer += this.decoder.end()
      if (this.stdoutBuffer.length > 0) {
        let line = this.stdoutBuffer
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length > 0) this.handleLine(line)
      }
      this.stdoutBuffer = ''
    })

    // stderr: capture for diagnostics
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrBuffer += text
      this.emit('stderr', text)
      console.log('[Pi STDERR]:', text.slice(0, 200))
    })
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
      if (isRpcChunkFrame(parsed)) {
        parsed = this.rpcFrameDecoder.push(parsed)
        if (parsed === undefined) return
      } else if (this.rpcFrameDecoder.hasPending()) {
        throw new Error('rpc chunk sequence interrupted')
      }
    } catch {
      this.rpcFrameDecoder.reset()
      this.emit('parse-error', line)
      return
    }
    const event = parsed as PiRpcEvent

    // OMP advertises readiness explicitly. Keep the probe fallback for the
    // original Pi RPC implementation, which has no ready frame.
    if ((event as { type?: unknown }).type === 'ready') {
      this.markReady?.()
      const ready = event as {
        supportedProtocolVersions?: unknown
        maxFrameBytes?: unknown
        maxReassembledFrameBytes?: unknown
      }
      // Adopt the engine's own framing limits before v2 traffic can arrive, so
      // the decoder never rejects a frame the sender considers legal.
      this.rpcFrameDecoder.configureLimits(ready)
      if (Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2)) {
        void this.sendCommand({ type: 'negotiate_protocol', protocolVersion: 2 }).catch(() => {})
      }
      return
    }

    // Correlate responses with pending requests
    if (event.type === 'response') {
      const responseEvent = event as PiResponseEvent
      // Startup readiness probe (see spawnAndAwaitReady): its correlated
      // response — success OR an "unknown command" error, both echoing our id —
      // means Pi is answering RPC. Flip to ready, then consume it silently so
      // it never surfaces as a stray event.
      if (responseEvent.id === STARTUP_PROBE_ID) {
        this.markReady?.()
        return
      }
      if (responseEvent.id) {
        const pending = this.pendingResponses.get(responseEvent.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingResponses.delete(responseEvent.id)
          pending.resolve(responseEvent)
          return
        }
      }
    }

    // Emit all events for subscribers
    this.emit('event', event)
    this.emit(event.type, event)
  }

  private setStatus(status: PiProcessStatus): void {
    if (this.status !== status) {
      this.status = status
      this.emit('status-change', status)
    }
  }

  /**
   * PIDs descended from `root`, children before grandchildren.
   *
   * A negative-PID signal only reaches the killed process's own group, and OMP
   * puts each subagent it spawns in a new group, so `hub` fan-out survives the
   * parent dying: the app exits, the subagents are re-parented to init, and
   * they keep running and keep billing. They have to be enumerated before the
   * parent is signalled, because re-parenting erases the link immediately.
   *
   * POSIX only. Windows has the same gap but `taskkill /T` is the fix there and
   * it cannot be verified from here, so that path is left as it was.
   */
  private descendantPids(root: number): number[] {
    if (IS_WINDOWS) return []
    const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf-8', timeout: PROCESS_TREE_TIMEOUT_MS })
    if (result.status !== 0 || typeof result.stdout !== 'string') return []

    const childrenByParent = new Map<number, number[]>()
    for (const line of result.stdout.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
      const siblings = childrenByParent.get(ppid)
      if (siblings) siblings.push(pid)
      else childrenByParent.set(ppid, [pid])
    }

    const found: number[] = []
    const queue = [root]
    // Breadth-first with a seen set: a malformed table must not loop forever.
    const seen = new Set<number>([root])
    while (queue.length > 0) {
      for (const child of childrenByParent.get(queue.shift()!) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        found.push(child)
        queue.push(child)
      }
    }
    return found
  }

  private kill(): void {
    // Settle any pending startup attempt first — after the listener teardown
    // below it could never settle on its own. No-op when already settled.
    this.abortStartup?.()
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Pi process killed'))
    }
    this.pendingResponses.clear()

    if (this.process) {
      const proc = this.process
      proc.removeAllListeners()
      proc.stdout?.removeAllListeners()
      proc.stderr?.removeAllListeners()
      const waiters = this.exitWaiters.get(proc)
      if (waiters?.size) {
        const settle = (): void => {
          this.exitWaiters.delete(proc)
          for (const waiter of waiters) waiter()
        }
        proc.once('exit', settle)
        proc.once('close', settle)
      }
      proc.stdin?.end()

      // Snapshot the tree before signalling: once the parent dies its children
      // are re-parented to init and can no longer be found from this pid.
      const strays = proc.pid ? this.descendantPids(proc.pid) : []

      // Kill entire process group (negative PID)
      try {
        if (proc.pid) {
          process.kill(-proc.pid, 'SIGTERM')
        }
      } catch {
        proc.kill('SIGTERM')
      }

      // Subagents sit in their own groups, so the group signal above misses
      // them. Signal each directly; ESRCH just means it already exited.
      for (const stray of strays) {
        try { process.kill(stray, 'SIGTERM') } catch { /* already gone */ }
      }

      // Force kill after timeout
      setTimeout(() => {
        try {
          if (proc.pid && !proc.killed) {
            process.kill(-proc.pid, 'SIGKILL')
          }
        } catch {
          try { proc.kill('SIGKILL') } catch { /* already dead */ }
        }
        for (const stray of strays) {
          try { process.kill(stray, 'SIGKILL') } catch { /* already gone */ }
        }
      }, FORCE_KILL_TIMEOUT_MS)

      this.process = null
    }

    this.stdoutBuffer = ''
    this.decoder = new StringDecoder('utf8')
    this.rpcFrameDecoder = new RpcFrameDecoder()
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingResponses.clear()
  }
}
