import { ChildProcess, SpawnOptions, spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type {
  PiRpcEvent,
  PiStartOptions,
  PiProcessStatus,
  PiStatus,
  PiResponseEvent,
} from '../shared/ipc-contracts'
import type { CaptureOptions, PiResolution, ResolutionDeps } from './pi-binary-resolution'
import {
  describePiResolutionFailure,
  normalizeOverride,
  resolvePiBinary,
  whichInPath,
} from './pi-binary-resolution'
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
const CONTINUE_FLAG = '--continue'
const IS_WINDOWS = process.platform === 'win32'
const SPAWN_STARTUP_TIMEOUT_MS = 15_000
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
// write raced Pi's stdin reader; SPAWN_STARTUP_TIMEOUT_MS bounds the wait.
const STARTUP_PROBE_ID = '__startup_probe__'
// get_state is the cheapest liveness command: a handful of in-memory session
// field reads — no I/O, no model/provider calls, O(1). (get_session_stats is
// O(messages) and get_available_models filters the model list.)
const STARTUP_PROBE_COMMAND = 'get_state'
const STARTUP_PROBE_INTERVAL_MS = 750
const FORCE_KILL_TIMEOUT_MS = 3_000

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
  script: string
  node: string
  useNode: boolean
  needsShell: boolean
  found: boolean
  nodeFound: boolean
  failureReason: string | null
}

// Resolution is lazy and cached rather than computed at import time, because
// it depends on the `piExecutablePath` setting, which is only readable once
// the app has loaded settings. setPiExecutableOverride() invalidates the cache.
let configuredOverride: string | null = null
let cachedResolution: PiResolution | null = null
let cachedNodeBinary: string | null = null

/**
 * Apply the `piExecutablePath` setting. Call on startup once settings are
 * loaded and again whenever the setting changes; the next Pi start picks it up
 * without an app restart.
 */
export function setPiExecutableOverride(raw: string | undefined | null): void {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const next = normalizeOverride(raw, home)
  if (next === configuredOverride && cachedResolution) return
  configuredOverride = next
  cachedResolution = null
  cachedNodeBinary = null
}

function getResolution(): PiResolution {
  if (cachedResolution) return cachedResolution
  const resolution = resolvePiBinary(RESOLUTION_DEPS, configuredOverride)
  // Adopt the login shell's PATH process-wide so Pi itself — and every helper
  // we spawn — can find node, npm and the tools the user's shell exposes.
  if (resolution.pathEnv && resolution.pathEnv !== process.env.PATH) {
    process.env.PATH = resolution.pathEnv
  }
  cachedResolution = resolution
  logResolution(resolution)
  return resolution
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

/**
 * The resolved Pi invocation. Also exported for ipc-handlers, which runs
 * `pi install/remove/update` with the same binary — Electron's own PATH won't
 * have `pi` on it.
 */
export function getPiCli(): PiCli {
  const resolution = getResolution()
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
    script: resolution.script,
    node,
    useNode: resolution.useNode,
    needsShell: resolution.needsShell,
    found: resolution.found,
    nodeFound,
    failureReason,
  }
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
  if (process.platform !== 'win32') return {}
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
  if (process.platform !== 'win32') return
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
  private startInFlight: Promise<PiStatus> | null = null
  // Set while a spawn attempt awaits readiness; handleLine invokes it when the
  // startup probe's correlated response arrives. Cleared once the attempt settles.
  private markReady: (() => void) | null = null

  getStatus(): PiStatus {
    return {
      status: this.status,
      pid: this.process?.pid ?? null,
      // Only report captured stderr as an error when we're actually in the
      // 'error' state. Pi and its extensions (e.g. pi-ollama) log benign,
      // informational lines to stderr while running — surfacing those as an
      // error misleads the UI into showing healthy startup logs as ERROR.
      error: this.status === 'error' ? (this.stderrBuffer || null) : null,
    }
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
    const cli = getPiCli()
    if (cli.failureReason) {
      this.stderrBuffer = cli.failureReason
      this.setStatus('error')
      console.error('[Pi] Pre-flight failed:', this.stderrBuffer)
      return this.getStatus()
    }

    // Spawn, with one retry reserved for a crash before readiness. See
    // STARTUP_MAX_ATTEMPTS: a crash is often transient; a timeout is not.
    for (let attempt = 1; attempt <= STARTUP_MAX_ATTEMPTS; attempt++) {
      const outcome = await this.spawnAndAwaitReady(options)
      if (outcome === 'ready') return this.getStatus()

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
          ? `Pi did not respond within ${SPAWN_STARTUP_TIMEOUT_MS / 1000}s.\n\n` +
            (captured
              ? `Pi stderr captured during startup:\n${captured}`
              : 'No output captured. Likely causes: Pi launched but stdio piping is broken (common with shell:true on Windows), or Pi is waiting on input. Try running `pi --mode rpc` directly in cmd to see if RPC mode works standalone.')
          : captured || 'Pi crashed before becoming ready.'
      return this.getStatus()
    }

    // Unreachable — the loop always returns — but satisfies the type checker.
    return this.getStatus()
  }

  /**
   * Spawn one Pi process and wait for it to become RPC-ready. Resolves:
   *  - 'ready'   — the readiness probe's correlated response arrived; status is
   *                now 'running'.
   *  - 'crashed' — spawn error, or the process exited before becoming ready.
   *  - 'timeout' — no response within SPAWN_STARTUP_TIMEOUT_MS.
   * It does NOT set the terminal 'error' status — doStart owns that, so it can
   * retry a crash without flipping the UI to 'error' between attempts.
   */
  private spawnAndAwaitReady(options: PiStartOptions): Promise<'ready' | 'crashed' | 'timeout'> {
    const args = this.buildArgs(options)
    const cli = getPiCli()

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
      console.log('[Pi] Spawning with cwd:', options.cwd)
      console.log(
        '[Pi] Spawn argv     :',
        cli.useNode ? [cli.node, cli.script, ...args] : [cli.script, ...args]
      )
      proc = cli.useNode
        ? spawn(cli.node, [cli.script, ...args], spawnOptions)
        : spawn(cli.script, args, spawnOptions)
    } catch (err) {
      this.stderrBuffer += (err instanceof Error ? err.message : String(err)) + '\n'
      return Promise.resolve('crashed')
    }
    this.process = proc
    this.setupStreams()

    return new Promise<'ready' | 'crashed' | 'timeout'>((resolve) => {
      let settled = false
      let probeTimer: NodeJS.Timeout | null = null
      const startedAt = Date.now()
      const finish = (outcome: 'ready' | 'crashed' | 'timeout'): void => {
        if (settled) return
        settled = true
        this.markReady = null
        if (probeTimer) {
          clearInterval(probeTimer)
          probeTimer = null
        }
        resolve(outcome)
      }

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

      // Hard deadline: give up if still 'starting' after the full timeout.
      setTimeout(() => {
        if (!settled && this.status === 'starting') {
          finish('timeout')
        }
      }, SPAWN_STARTUP_TIMEOUT_MS)
    })
  }

  stop(): void {
    this.kill()
    this.setStatus('stopped')
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

  private buildArgs(options: PiStartOptions): string[] {
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

    if (options.sessionPath) {
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

  private setupStreams(): void {
    if (!this.process) return

    // stdout: JSONL events
    this.process.stdout?.on('data', (chunk: Buffer) => {
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
    let event: PiRpcEvent
    try {
      event = JSON.parse(line) as PiRpcEvent
    } catch {
      this.emit('parse-error', line)
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

  private kill(): void {
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
      proc.stdin?.end()

      // Kill entire process group (negative PID)
      try {
        if (proc.pid) {
          process.kill(-proc.pid, 'SIGTERM')
        }
      } catch {
        proc.kill('SIGTERM')
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
      }, FORCE_KILL_TIMEOUT_MS)

      this.process = null
    }

    this.stdoutBuffer = ''
    this.decoder = new StringDecoder('utf8')
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingResponses.clear()
  }
}
