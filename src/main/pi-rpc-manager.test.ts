import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import {
  buildPiArgs,
  buildPiInvocation,
  buildPiRunEnv,
  detectPiInstallations,
  findNodeBinary,
  PiRpcManager,
  RESOLUTION_DEPS,
  RpcTimeoutError,
  resolveStartCli,
  RpcFrameDecoder,
  setPiExecutableOverride,
  toPiCli,
  type PiCli,
} from './pi-rpc-manager'
import type { PiResolution, ResolutionDeps } from './pi-binary-resolution'
import { appLog } from './app-log'
import { FORCE_KILL_TIMEOUT_MS, forceKillStoppingProcessTrees, windowsTreeKillArgs } from './process-tree-kill'
import { piDotenvPath } from './pi-dotenv'
import { NO_CWD_EXE_SEARCH_VARIABLE, disableCwdExecutableSearch } from './windows-exe-search'
import { i18n } from '../shared/i18n'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE } from '../shared/i18n/languages'
import { makeTempDir } from '../shared/temp-dir.test-helper'

/** A pseudo-language string: bracketed and padded with "~" (see pseudo.ts). */
const PSEUDO_MARKED = /^\[[^]*~+\]$/
const PREFLIGHT_LOG_MESSAGE = 'Pre-flight failed'

/** The sender's chunk size: OMP protocol v2 splits payloads at 256 KiB. */
const CHUNK_PAYLOAD_BYTES = 256 * 1024
/** The frame size the decoder used to demand before it would reassemble. */
const REMOVED_FRAME_FLOOR_BYTES = 1024 * 1024
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024

/**
 * A resolution fixture. `needsShell` is only ever true on Windows for a
 * `.cmd`/`.bat`/`.ps1` shim, and never together with `useNode` — see
 * pi-binary-resolution.finalize.
 */
function piCli(overrides: Partial<PiCli> = {}): PiCli {
  return {
    script: '/usr/local/bin/pi',
    node: '/usr/bin/node',
    useNode: false,
    needsShell: false,
    found: true,
    nodeFound: true,
    failureReason: null,
    ...overrides,
  }
}

/** The physical frames a sender emits for one logical frame, in wire order. */
function chunkFrames(chunkId: string, payload: string): Array<Record<string, unknown>> {
  const bytes = Buffer.from(payload, 'utf8')
  const count = Math.ceil(bytes.length / CHUNK_PAYLOAD_BYTES)
  return Array.from({ length: count }, (_unused, index) => ({
    type: 'rpc_chunk',
    chunkId,
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * CHUNK_PAYLOAD_BYTES, (index + 1) * CHUNK_PAYLOAD_BYTES).toString('base64'),
  }))
}

function decodeAll(frames: Array<Record<string, unknown>>): object | undefined {
  const decoder = new RpcFrameDecoder()
  let decoded: object | undefined
  for (const frame of frames) {
    const result = decoder.push(frame)
    if (result) decoded = result
  }
  return decoded
}

function responsePayload(size: number, filler: string): string {
  return JSON.stringify({ type: 'response', command: 'get_messages', success: true, data: filler.repeat(size) })
}

test('fresh sessions launch with the remembered model and reasoning', () => {
  assert.deepEqual(buildPiArgs({
    provider: 'test', model: 'test-model', defaultThinkingLevel: 'high', continueSession: false,
  }), ['--mode', 'rpc', '--provider', 'test', '--model', 'test-model', '--thinking', 'high'])
  assert.equal(buildPiArgs({}).includes('--thinking'), false)
  assert.ok(buildPiArgs({ defaultThinkingLevel: 'off' }).includes('off'))
})

test('remembered reasoning never overrides a resumed or forked session', () => {
  for (const binding of [
    { sessionPath: '/sessions/existing.jsonl' },
    { forkSessionPath: '/sessions/parent.jsonl' },
    { continueSession: true },
  ]) {
    assert.equal(buildPiArgs({ defaultThinkingLevel: 'high', ...binding }).includes('--thinking'), false)
  }
})

test('explicit thinking arguments override the saved preference', () => {
  for (const args of [['--thinking', 'low'], ['--thinking=low']]) {
    assert.deepEqual(buildPiArgs({ defaultThinkingLevel: 'high', args }), ['--mode', 'rpc', ...args])
  }
})

test('RpcFrameDecoder reassembles a lossless OMP protocol-v2 frame', () => {
  const frames = chunkFrames('rpc-test', responsePayload(1_100_000, 'x'))
  assert.equal((decodeAll(frames) as { data?: string }).data?.length, 1_100_000)
})

test('RpcFrameDecoder reassembles a two-chunk frame smaller than one whole frame', () => {
  // 300 KiB splits into exactly two chunks, and two chunks can never reach the
  // 1 MiB floor the metadata check used to impose — every such sequence was
  // discarded, leaving sendCommand to time out with an empty result.
  const payload = responsePayload(300 * 1024, 'y')
  const frames = chunkFrames('rpc-small', payload)
  assert.equal(frames.length, 2)
  assert.ok(Buffer.byteLength(payload, 'utf8') < REMOVED_FRAME_FLOOR_BYTES)

  const decoded = decodeAll(frames)
  assert.deepEqual(decoded, JSON.parse(payload))
})

test('RpcFrameDecoder still refuses a declared length above the reassembly limit', () => {
  const decoder = new RpcFrameDecoder()
  const frame = {
    type: 'rpc_chunk',
    chunkId: 'rpc-huge',
    index: 0,
    count: 2,
    byteLength: MAX_REASSEMBLED_BYTES + 1,
    data: Buffer.from('a').toString('base64'),
  }
  assert.throws(() => decoder.push(frame), /invalid rpc chunk metadata/)
  assert.equal(decoder.hasPending(), false)
})

test('RpcFrameDecoder rejects a sequence that does not match its declared length', () => {
  const frames = chunkFrames('rpc-lying', responsePayload(300 * 1024, 'z'))
  const inflated = frames.map((frame) => ({ ...frame, byteLength: (frame.byteLength as number) + 1 }))
  assert.throws(() => decodeAll(inflated), /length mismatch/)
})

test('RpcFrameDecoder can be reset after an interrupted sequence', () => {
  const decoder = new RpcFrameDecoder()
  const first = {
    type: 'rpc_chunk',
    chunkId: 'rpc-a',
    index: 0,
    count: 2,
    byteLength: 2,
    data: Buffer.from('a').toString('base64'),
  }
  decoder.push(first)
  assert.equal(decoder.hasPending(), true)
  assert.throws(() => decoder.push({ ...first, chunkId: 'rpc-b' }), /sequence mismatch/)
  decoder.reset()
  assert.equal(decoder.hasPending(), false)
})

test('no start forces a session directory on the engine', () => {
  // Pointing OMP at Pi's root only moved resumed sessions — OMP ignores the
  // flag for new ones — so one conversation history ended up split across both
  // trees. Each engine now keeps its own store and the index reads both.
  assert.deepEqual(buildPiArgs({ cwd: '/projects/app' }), ['--mode', 'rpc'])
  assert.deepEqual(buildPiArgs({ engine: 'omp', cwd: '/projects/app' }), ['--mode', 'rpc'])
  assert.deepEqual(buildPiArgs({ engine: 'pi', cwd: '/projects/app' }), ['--mode', 'rpc'])
})

test('a caller that asks for a shared session directory still gets one', () => {
  assert.deepEqual(
    buildPiArgs({ engine: 'omp', args: ['--session-dir', '/shared/sessions'] }),
    ['--mode', 'rpc', '--session-dir', '/shared/sessions'],
  )
})

test('an explicit session path is passed to the engine that owns it', () => {
  assert.deepEqual(
    buildPiArgs({ engine: 'omp', sessionPath: '/home/u/.omp/agent/sessions/--p--/s.jsonl' }),
    ['--mode', 'rpc', '--session', '/home/u/.omp/agent/sessions/--p--/s.jsonl'],
  )
  // --session wins over the resume preference, so opening a session never
  // silently lands on "the most recent session for this cwd" instead.
  assert.deepEqual(
    buildPiArgs({ sessionPath: '/sessions/s.jsonl', continueSession: true }),
    ['--mode', 'rpc', '--session', '/sessions/s.jsonl'],
  )
})

test('a start resolves the engine that owns the session, without moving the configured one', () => {
  // Sandbox HOME/PATH so both engines resolve inside the fixture directory and
  // the login-shell probe cannot widen PATH (see detectPiInstallations below).
  const dir = mkdtempSync(join(tmpdir(), 'pi-engine-'))
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL }
  try {
    process.env.HOME = dir
    process.env.PATH = dir
    process.env.SHELL = join(dir, 'no-such-shell')
    writeFileSync(join(dir, 'pi'), '')
    writeFileSync(join(dir, 'omp'), '')
    // The user's configured default: Pi for everything.
    setPiExecutableOverride(null, 'pi')

    assert.deepEqual(
      { kind: resolveStartCli({ engine: 'omp' }).kind, script: resolveStartCli({ engine: 'omp' }).script },
      { kind: 'omp', script: join(dir, 'omp') },
      'an OMP session must start OMP even though Pi is the configured engine',
    )
    assert.equal(resolveStartCli({ engine: 'pi' }).script, join(dir, 'pi'))
    assert.equal(resolveStartCli({}).script, join(dir, 'pi'), 'no engine means the configured one')
    // The override is a parameter, never a global the caller flips: two session
    // runtimes start concurrently, so a mutated global would leak one session's
    // engine into another session's spawn.
    assert.equal(resolveStartCli({}).kind, 'pi', 'resolving OMP must not change the configured engine')
  } finally {
    setPiExecutableOverride(null, 'auto')
    process.env.HOME = saved.HOME
    process.env.PATH = saved.PATH
    if (saved.SHELL === undefined) delete process.env.SHELL
    else process.env.SHELL = saved.SHELL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session whose engine is not installed still opens under the configured one', () => {
  const dir = makeTempDir('pi-engine-missing-')
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL }
  try {
    process.env.HOME = dir
    process.env.PATH = dir
    process.env.SHELL = join(dir, 'no-such-shell')
    writeFileSync(join(dir, 'pi'), '')
    setPiExecutableOverride(null, 'pi')

    // No `omp` binary in the sandbox. Both engines write the same JSONL, so
    // opening the conversation beats refusing to open it.
    const cli = resolveStartCli({ engine: 'omp' })
    assert.equal(cli.script, join(dir, 'pi'))
    assert.equal(cli.found, true)
    assert.equal(cli.failureReason, null)
  } finally {
    setPiExecutableOverride(null, 'auto')
    process.env.HOME = saved.HOME
    process.env.PATH = saved.PATH
    if (saved.SHELL === undefined) delete process.env.SHELL
    else process.env.SHELL = saved.SHELL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pre-flight failure shows interface text and logs English', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-preflight-language-'))
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL }
  await i18n.changeLanguage(PSEUDO_LANGUAGE)
  try {
    process.env.HOME = dir
    process.env.PATH = dir
    process.env.SHELL = join(dir, 'no-such-shell')
    writeFileSync(join(dir, 'pi'), '')
    setPiExecutableOverride(null, 'pi')
    const missingCwd = join(dir, 'missing')

    const status = await new PiRpcManager().start({ cwd: missingCwd })

    assert.equal(status.status, 'error')
    // The UI text is in the interface language; the path inside it is not.
    assert.match(status.error ?? '', PSEUDO_MARKED)
    assert.ok(status.error?.includes(missingCwd))
    // The log feeds the diagnostics report, which stays English.
    const logged = appLog.getRecent().filter((entry) => entry.message === PREFLIGHT_LOG_MESSAGE).at(-1)
    assert.equal(logged?.detail, `Pi working directory does not exist or is not a directory:\n  ${missingCwd}`)
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
    setPiExecutableOverride(null, 'auto')
    process.env.HOME = saved.HOME
    process.env.PATH = saved.PATH
    if (saved.SHELL === undefined) delete process.env.SHELL
    else process.env.SHELL = saved.SHELL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildPiInvocation escapes the shim path and args for the Windows cmd.exe hop', () => {
  const cli = piCli({ script: String.raw`C:\Program Files\nodejs\pi.cmd`, needsShell: true })
  assert.deepEqual(buildPiInvocation(cli, ['--mode', 'rpc', '--session', 'a&calc']), {
    file: String.raw`"C:\Program Files\nodejs\pi.cmd"`,
    args: ['--mode', 'rpc', '--session', '"a&calc"'],
  })
})

test('buildPiInvocation escapes cmd metacharacters coming from the user profile path', () => {
  const cli = piCli({ script: String.raw`C:\Users\Tom & Jerry\100%\pi.cmd`, needsShell: true })
  assert.equal(
    buildPiInvocation(cli, []).file,
    String.raw`"C:\Users\Tom & Jerry\100"^%"\pi.cmd"`,
  )
})

test('buildPiInvocation leaves the node path byte-identical', () => {
  // useNode implies needsShell false (a .js entry point is launched directly),
  // so nothing may be rewritten even when the paths contain spaces.
  const cli = piCli({
    script: String.raw`C:\Program Files\nodejs\node_modules\pi\cli.js`,
    node: String.raw`C:\Program Files\nodejs\node.exe`,
    useNode: true,
  })
  assert.deepEqual(buildPiInvocation(cli, ['--mode', 'rpc', '--session', 'a&calc']), {
    file: String.raw`C:\Program Files\nodejs\node.exe`,
    args: [
      String.raw`C:\Program Files\nodejs\node_modules\pi\cli.js`,
      '--mode',
      'rpc',
      '--session',
      'a&calc',
    ],
  })
})

test('buildPiInvocation leaves a direct POSIX spawn byte-identical', () => {
  const cli = piCli({ script: '/home/tester/my agents/pi' })
  assert.deepEqual(buildPiInvocation(cli, ['--mode', 'rpc', '--session', 'a&calc']), {
    file: '/home/tester/my agents/pi',
    args: ['--mode', 'rpc', '--session', 'a&calc'],
  })
})

test('buildPiInvocation preserves fork startup arguments', () => {
  const cli = piCli()
  assert.deepEqual(buildPiInvocation(cli, ['--mode', 'rpc', '--fork', '/sessions/source.jsonl']), {
    file: '/usr/local/bin/pi',
    args: ['--mode', 'rpc', '--fork', '/sessions/source.jsonl'],
  })
})

// ─── Node lookup: no bare fallback ───────────────────────────────────────────
//
// Pi's cli.js runs with the Node binary found here, and the spawn's working
// directory is the workspace. A bare `node.exe` fallback would make Windows
// look in that workspace first, so "not found" has to stay not found.

const WINDOWS_LOCAL_APP_DATA = 'C:\\Users\\tester\\AppData\\Local'

/** Filesystem-only resolver deps: `files` exist and no probe answers. */
function nodeLookupDeps(isWindows: boolean, env: NodeJS.ProcessEnv, files: string[] = []): ResolutionDeps {
  const existing = new Set(files)
  return {
    isWindows,
    env,
    exists: (path) => existing.has(path),
    isDirectory: () => false,
    listDir: () => [],
    capture: () => null,
  }
}

test('findNodeBinary reports no Node instead of a bare name the OS would look up in the workspace', () => {
  assert.equal(findNodeBinary(nodeLookupDeps(true, { LOCALAPPDATA: WINDOWS_LOCAL_APP_DATA, PATH: 'C:\\Windows' })), null)
  assert.equal(findNodeBinary(nodeLookupDeps(false, { PATH: '/nowhere' })), null)
})

test('findNodeBinary takes Node from an absolute PATH entry, never from a relative one', () => {
  const pathDir = 'D:\\node'
  const deps = nodeLookupDeps(
    true,
    { LOCALAPPDATA: WINDOWS_LOCAL_APP_DATA, PATH: ['.', pathDir].join(';'), PATHEXT: '.EXE' },
    [join('.', 'node.exe'), join(pathDir, 'node.exe')],
  )
  assert.equal(findNodeBinary(deps), join(pathDir, 'node.exe'))
})

test('a cli.js engine with no Node binary fails as node-not-found, so nothing is spawned', () => {
  const resolution: PiResolution = {
    script: '/opt/pi/cli.js',
    useNode: true,
    needsShell: false,
    source: 'override',
    found: true,
    rejectedOverride: null,
    pathEnv: '/usr/bin',
  }
  const cli = toPiCli(resolution, 'pi', null)
  assert.equal(cli.nodeFound, false)
  assert.deepEqual(cli.failureReason, { kind: 'node-not-found', node: cli.node })
  // An executable that runs directly needs no Node at all.
  assert.equal(toPiCli({ ...resolution, script: '/opt/pi/pi', useNode: false }, 'pi', null).failureReason, null)
})

test('buildPiInvocation rejects arguments cmd.exe cannot carry', () => {
  const cli = piCli({ script: String.raw`C:\npm\pi.cmd`, needsShell: true })
  assert.throws(
    () => buildPiInvocation(cli, ['--session', 'a\nb']),
    /cannot be passed through cmd\.exe/,
  )
  // Off the cmd path the same value is passed through as-is: spawn hands argv
  // to the OS directly, so there is nothing to truncate a command line.
  assert.deepEqual(buildPiInvocation(piCli(), ['--session', 'a\nb']).args, ['--session', 'a\nb'])
})

// ─── Startup deadline behavior (issues #58, #98) ────────────────────────────
//
// Pi's RPC mode prints nothing until it answers the readiness probe, and the
// engine runs every extension session_start hook before it reads stdin. So a
// healthy Pi can stay unready for tens of seconds, with or without output.
// Every process that is still running gets the one long deadline; a process
// that dies ends the attempt at once through its exit event.

/** Fast test timings — real values are 20s / 120s. */
// These integration tests cross a child-process boundary; fake timers cannot
// advance the engine's own clock.
const TEST_WAITING_NOTICE_MS = 400
const TEST_READY_MS = 2_000
/** Probe id the manager correlates on; fixed by the wire protocol. */
const PROBE_ID = '__startup_probe__'
/** Fixture heartbeat: proves liveness well within the notice delay. */
const HEARTBEAT_MS = 100
/** Late-ready fixtures answer between the notice delay and the deadline. */
const LATE_READY_DELAY_MS = 900
const FAKE_EXIT_CODE = 7
/** Real time past the force-kill delay for its timer to have fired. */
const FORCE_KILL_SETTLE_MS = 250
/** Poll step while a test waits for a fixture process to appear or end. */
const PROCESS_POLL_MS = 50
/** Upper bound for the stubborn tool child to start and report its pid. */
const CHILD_START_DEADLINE_MS = 2_000
/** A quit must end a stubborn child well before the force-kill timer fires. */
const QUIT_KILL_DEADLINE_MS = 1_000
/** `ps` marks a zombie (ended, not yet reaped) with this state letter. */
const ZOMBIE_STATE = 'Z'
/**
 * A tool child that ignores SIGTERM. It writes its pid only after the handler
 * is in place, so a test never signals it before it can ignore the signal.
 */
const STUBBORN_CHILD_SOURCE =
  "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Rejects instead of hanging when `promise` does not settle within `ms`. */
async function withinDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Did not settle within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}
const SKIP_ON_WINDOWS = { skip: process.platform === 'win32' ? 'POSIX shebang fixture' : false }

/**
 * A stand-in engine. Modes via FAKE_PI_MODE:
 *  - 'silent'            — stays alive, never writes stdout.
 *  - 'silent-late-ready' — writes nothing until it answers the probe after
 *                          FAKE_PI_READY_DELAY_MS.
 *  - 'late-ready'        — emits frames immediately, answers the probe only
 *                          after FAKE_PI_READY_DELAY_MS.
 *  - 'never-ready'       — emits frames forever, never answers the probe.
 *  - 'exit'              — exits at once with FAKE_EXIT_CODE.
 * In every mode, the engine also exits at once with FAKE_EXIT_CODE when it
 * inherited the variable FAKE_PI_EXIT_IF_ENV names (in any letter case).
 * With FAKE_PI_STUBBORN_CHILD_FILE set, it also starts a child that ignores
 * SIGTERM and writes its pid to that file; FAKE_PI_STUBBORN_CHILD_DETACHED=1
 * puts that child in its own process group, as OMP does with subagents.
 */
const FAKE_ENGINE_SOURCE = `#!/usr/bin/env node
const mode = process.env.FAKE_PI_MODE || 'silent'
const readyDelayMs = Number(process.env.FAKE_PI_READY_DELAY_MS || '0')
const forbiddenName = (process.env.FAKE_PI_EXIT_IF_ENV || '').toLowerCase()
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
if (mode === 'exit') process.exit(${FAKE_EXIT_CODE})
if (forbiddenName && Object.keys(process.env).some((name) => name.toLowerCase() === forbiddenName)) process.exit(${FAKE_EXIT_CODE})
if (process.env.FAKE_PI_STUBBORN_CHILD_FILE) {
  require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(STUBBORN_CHILD_SOURCE)}, process.env.FAKE_PI_STUBBORN_CHILD_FILE], {
    stdio: 'ignore',
    detached: process.env.FAKE_PI_STUBBORN_CHILD_DETACHED === '1',
  })
}
if (mode === 'late-ready' || mode === 'never-ready') {
  emit({ type: 'extension_ui_request', id: 'boot', method: 'setStatus', statusKey: 'boot', statusText: 'loading' })
  setInterval(() => emit({ type: 'extension_ui_request', id: 'hb', method: 'setStatus', statusKey: 'hb', statusText: 'busy' }), ${HEARTBEAT_MS})
}
if (mode === 'late-ready' || mode === 'silent-late-ready') {
  setTimeout(() => emit({ id: '${PROBE_ID}', type: 'response', command: 'get_state', success: true }), readyDelayMs)
}
if (mode === 'rpc') {
  emit({ id: '${PROBE_ID}', type: 'response', command: 'get_state', success: true })
  let lastHeldPromptId = null
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    while (true) {
      const idx = buffer.indexOf('\\n')
      if (idx === -1) break
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id === '${PROBE_ID}') {
          emit({ id: '${PROBE_ID}', type: 'response', command: 'get_state', success: true })
        } else if (msg.type === 'prompt') {
          if (msg.message === 'hold-for-input') {
            lastHeldPromptId = msg.id
            emit({ type: 'extension_ui_request', id: 'ui-input-1', method: 'input', title: 'Need input' })
          } else if (msg.message === 'hold-for-sequential') {
            lastHeldPromptId = msg.id
            emit({ type: 'extension_ui_request', id: 'seq-1', method: 'input', title: 'Need sequential 1' })
          } else if (msg.message === 'hold-for-cancel') {
            lastHeldPromptId = msg.id
            emit({ type: 'extension_ui_request', id: 'ui-cancel-1', method: 'select', title: 'Need select' })
          } else if (msg.message === 'hold-with-notify') {
            emit({ type: 'extension_ui_request', id: 'ui-notify-1', method: 'notify', message: 'Just notify' })
          } else if (msg.message === 'hold-for-teardown') {
            lastHeldPromptId = msg.id
            emit({ type: 'extension_ui_request', id: 'ui-input-teardown', method: 'input', title: 'Teardown input' })
          } else {
            emit({ id: msg.id, type: 'response', command: 'prompt', success: true })
          }
        } else if (msg.type === 'extension_ui_response') {
          if (msg.id === 'seq-1') {
            emit({ type: 'extension_ui_request', id: 'seq-2', method: 'confirm', message: 'Need sequential 2' })
          } else if (lastHeldPromptId) {
            emit({ id: lastHeldPromptId, type: 'response', command: 'prompt', success: true, answer: msg })
            lastHeldPromptId = null
          }
        } else if (msg.type === 'trigger-cancel') {
          emit({ type: 'extension_ui_request', method: 'cancel', targetId: 'ui-cancel-1' })
          // intentionally do not answer to test timeout
        } else if (msg.id) {
          emit({ id: msg.id, type: 'response', command: String(msg.type), success: true })
        }
      } catch {}
    }
  })
}
process.stdin.resume()
`

async function withFakeEngine(
  run: (manager: PiRpcManager, startEnv: Record<string, string>) => Promise<void>,
  env: Record<string, string>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fake-engine-'))
  const script = join(dir, 'fake-pi')
  writeFileSync(script, FAKE_ENGINE_SOURCE)
  chmodSync(script, 0o755)
  const savedShell = process.env.SHELL
  // Startup timing must not include the developer's interactive shell setup.
  process.env.SHELL = join(dir, 'no-such-shell')
  setPiExecutableOverride(script, 'pi')
  const manager = new PiRpcManager({ waitingNoticeMs: TEST_WAITING_NOTICE_MS, readyMs: TEST_READY_MS })
  try {
    await run(manager, env)
  } finally {
    manager.stop()
    setPiExecutableOverride(null, 'auto')
    if (savedShell === undefined) delete process.env.SHELL
    else process.env.SHELL = savedShell
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Starts Pi, checks the waiting notice between the two timings, and expects ready. */
async function assertReadyAfterWaitingNotice(manager: PiRpcManager, env: Record<string, string>): Promise<void> {
  const phases: string[] = []
  manager.on('startup-phase', (phase: string) => phases.push(phase))

  const waiting = once(manager, 'startup-phase')
  const started = manager.start({ env })
  const [phase] = await Promise.race([
    waiting,
    started.then((status) => {
      throw new Error(`Startup ended before the waiting notice: ${status.status}: ${status.error ?? ''}`)
    }),
  ])
  assert.equal(phase, 'waiting-on-engine')
  assert.equal(manager.getStatus().status, 'starting', 'the notice does not end startup')
  assert.equal(manager.getStatus().startupPhase, 'waiting-on-engine')

  const status = await started
  assert.equal(status.status, 'running', 'a late probe response still means ready')
  assert.equal(status.startupPhase, undefined, 'phase reporting ends with startup')
  assert.deepEqual(phases, ['waiting-on-engine'], 'the phase flip is announced once')
}

test('startup keeps waiting past the notice delay while Pi is emitting output', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(
    assertReadyAfterWaitingNotice,
    { FAKE_PI_MODE: 'late-ready', FAKE_PI_READY_DELAY_MS: String(LATE_READY_DELAY_MS) },
  )
})

test('startup keeps waiting past the notice delay while a running Pi stays silent', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(
    assertReadyAfterWaitingNotice,
    { FAKE_PI_MODE: 'silent-late-ready', FAKE_PI_READY_DELAY_MS: String(LATE_READY_DELAY_MS) },
  )
})

test('a silent never-ready Pi fails at the deadline with a no-output error', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(async (manager, env) => {
    const startedAt = Date.now()
    const status = await manager.start({ env })
    assert.equal(status.status, 'error')
    assert.ok(Date.now() - startedAt >= TEST_READY_MS, 'the full deadline is granted before giving up')
    assert.match(status.error ?? '', /produced no output within 2s/)
    // The old message asserted two specific causes that misdiagnosed issue
    // #58 for days; the error must not name them any more.
    assert.doesNotMatch(status.error ?? '', /shell:true|waiting on input/)
    assert.equal(status.startupPhase, undefined, 'phase reporting ends with startup')
  }, { FAKE_PI_MODE: 'silent' })
})

test('a chatty but never-ready Pi fails at the deadline with an engine-busy error', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(async (manager, env) => {
    const startedAt = Date.now()
    const status = await manager.start({ env })
    assert.equal(status.status, 'error')
    assert.ok(Date.now() - startedAt >= TEST_READY_MS, 'the full deadline is granted before giving up')
    assert.match(status.error ?? '', /did not become ready within 2s/)
    assert.match(status.error ?? '', /model server/, 'the message points at the real cause class')
    assert.equal(status.startupPhase, undefined, 'phase reporting ends with startup')
  }, { FAKE_PI_MODE: 'never-ready' })
})

test('a Pi that exits before ready fails fast without waiting for the deadline', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(async (manager, env) => {
    const startedAt = Date.now()
    const status = await manager.start({ env })
    assert.equal(status.status, 'error')
    assert.match(status.error ?? '', new RegExp(`exited with code ${FAKE_EXIT_CODE} before becoming ready`))
    assert.ok(Date.now() - startedAt < TEST_READY_MS, 'a dead process must not inherit the deadline')
  }, { FAKE_PI_MODE: 'exit' })
})
test('a start right after a stop during startup spawns a new process with the new options', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(async (manager) => {
    // The first options never become ready, so only a new spawn with the new
    // options can reach running before the deadline.
    const first = manager.start({ env: { FAKE_PI_MODE: 'silent' } })
    const firstPid = manager.getStatus().pid
    assert.equal(manager.getStatus().status, 'starting')

    manager.stop()
    const second = await withinDeadline(manager.start({ env: { FAKE_PI_MODE: 'late-ready' } }), TEST_READY_MS)

    assert.equal(second.status, 'running', 'the restart must not join the aborted attempt')
    assert.notEqual(second.pid, firstPid)
    assert.notEqual((await withinDeadline(first, TEST_READY_MS)).status, 'error', 'the aborted attempt settles without an error')
    assert.equal(manager.getStatus().status, 'running', 'the aborted attempt leaves the new process alone')
  }, {})
})

test('the force kill never signals a process group that has already ended', SKIP_ON_WINDOWS, async (t) => {
  await withFakeEngine(async (manager, env) => {
    const started = await withinDeadline(manager.start({ env }), TEST_READY_MS)
    assert.equal(started.status, 'running')
    const groupId = -(started.pid ?? 0)

    // Records every signal and still delivers it, so the child really exits.
    const kill = t.mock.method(process, 'kill')
    manager.stop()
    await withinDeadline(manager.processExited(), FORCE_KILL_TIMEOUT_MS)
    await delay(FORCE_KILL_TIMEOUT_MS + FORCE_KILL_SETTLE_MS)

    // Compare plain arguments only: a call record holds the whole `process`
    // object as `this`, and a failing diff of it exhausts memory.
    const forceKills = kill.mock.calls
      .map((call) => call.arguments)
      .filter(([pid, signal]) => pid === groupId && signal === 'SIGKILL')
    assert.deepEqual(forceKills, [], 'an exited child pid may already belong to another process')
  }, { FAKE_PI_MODE: 'late-ready' })
})

/** True while `pid` runs; a zombie has ended and counts as gone. */
function isRunning(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8', timeout: PROCESS_POLL_MS * 20 })
  if (result.status !== 0) return false
  return !result.stdout.trim().startsWith(ZOMBIE_STATE)
}

async function pollUntil(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${ms}ms`)
    await delay(PROCESS_POLL_MS)
  }
}

async function readStubbornChildPid(file: string): Promise<number> {
  let pid = Number.NaN
  await pollUntil(() => {
    if (existsSync(file)) pid = Number(readFileSync(file, 'utf-8'))
    return Number.isInteger(pid) && pid > 0
  }, CHILD_START_DEADLINE_MS, 'The stubborn child did not report its pid')
  return pid
}

/** Runs `run` against Pi with a stubborn tool child, and never leaves the child running. */
async function withStubbornChild(
  detached: boolean,
  run: (manager: PiRpcManager, childPid: number) => Promise<void>,
): Promise<void> {
  const pidDir = mkdtempSync(join(tmpdir(), 'pi-stubborn-child-'))
  const pidFile = join(pidDir, 'child.pid')
  let childPid: number | undefined
  try {
    await withFakeEngine(async (manager, env) => {
      const started = await withinDeadline(manager.start({ env }), TEST_READY_MS)
      assert.equal(started.status, 'running')
      childPid = await readStubbornChildPid(pidFile)
      await run(manager, childPid)
    }, {
      FAKE_PI_MODE: 'rpc',
      FAKE_PI_STUBBORN_CHILD_FILE: pidFile,
      FAKE_PI_STUBBORN_CHILD_DETACHED: detached ? '1' : '0',
    })
  } finally {
    if (childPid !== undefined) {
      try { process.kill(childPid, 'SIGKILL') } catch { /* already gone */ }
    }
    rmSync(pidDir, { recursive: true, force: true })
  }
}

test('a stop force-kills a same-group child that ignores SIGTERM after Pi has exited', SKIP_ON_WINDOWS, async () => {
  await withStubbornChild(false, async (manager, childPid) => {
    manager.stop()
    await withinDeadline(manager.processExited(), FORCE_KILL_TIMEOUT_MS)
    assert.ok(isRunning(childPid), 'the child outlives the SIGTERM that ended Pi')
    await pollUntil(
      () => !isRunning(childPid),
      FORCE_KILL_TIMEOUT_MS + FORCE_KILL_SETTLE_MS,
      'The force kill did not reach the child',
    )
  })
})

for (const detached of [false, true]) {
  const placement = detached ? 'in its own process group' : 'in the Pi process group'
  test(`a quit kills a stubborn child ${placement} without waiting for the force-kill timer`, SKIP_ON_WINDOWS, async () => {
    await withStubbornChild(detached, async (manager, childPid) => {
      const quitStartedAt = Date.now()
      await withinDeadline(manager.stopAndWait(), QUIT_KILL_DEADLINE_MS)
      forceKillStoppingProcessTrees()
      await pollUntil(
        () => !isRunning(childPid),
        QUIT_KILL_DEADLINE_MS - (Date.now() - quitStartedAt),
        'The quit did not end the child',
      )
    })
  })
}

test('the Windows tree kill ends the child and everything it started, by force', () => {
  const PID = 4242
  assert.deepEqual(windowsTreeKillArgs(PID), ['/pid', String(PID), '/T', '/F'])
})

test('prompt command survives human extension UI wait, ordinary commands expire, and teardown rejects', SKIP_ON_WINDOWS, async (t) => {
  await withFakeEngine(async (manager, env) => {
    const started = await manager.start({ env })
    assert.equal(started.status, 'running')

    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      // 1. Prompt survives human wait during blocking extension UI, then response settles
      const uiEventPromise = once(manager, 'extension_ui_request')
      const promptPromise = manager.sendCommand({ type: 'prompt', message: 'hold-for-input' })
      const [uiEvent] = (await uiEventPromise) as [Record<string, unknown>]
      assert.equal(uiEvent.method, 'input')
      assert.equal(uiEvent.id, 'ui-input-1')

      // Advance past 30s generic transport deadline while human is deciding
      t.mock.timers.tick(35_000)

      // Submit user response to the blocking UI request
      manager.sendExtensionUiResponse('ui-input-1', { value: 'user provided text' })
      const promptResponse = await promptPromise
      assert.equal(promptResponse?.success, true)
      // 2. Sequential approvals within one prompt survive multiple waits
      const seqUi1Promise = once(manager, 'extension_ui_request')
      const seqPromptPromise = manager.sendCommand({ type: 'prompt', message: 'hold-for-sequential' })
      const [seqUi1] = (await seqUi1Promise) as [Record<string, unknown>]
      assert.equal(seqUi1.method, 'input')
      assert.equal(seqUi1.id, 'seq-1')
      t.mock.timers.tick(35_000)

      const seqUi2Promise = once(manager, 'extension_ui_request')
      manager.sendExtensionUiResponse('seq-1', { value: 'first step' })
      const [seqUi2] = (await seqUi2Promise) as [Record<string, unknown>]
      assert.equal(seqUi2.method, 'confirm')
      assert.equal(seqUi2.id, 'seq-2')
      t.mock.timers.tick(35_000)

      manager.sendExtensionUiResponse('seq-2', { confirmed: true })
      const seqResponse = await seqPromptPromise
      assert.equal(seqResponse?.success, true)

      // 3. Ordinary commands still expire at the 30s deadline
      const hangPromise = manager.sendCommand({ type: 'hang' })
      t.mock.timers.tick(30_000)
      await assert.rejects(hangPromise, (err: unknown) => {
        assert.ok(err instanceof RpcTimeoutError)
        assert.equal(err.commandType, 'hang')
        return true
      })

      // 4. Non-blocking notify does not pause deadlines; prompt expires normally
      const notifyEventPromise = once(manager, 'extension_ui_request')
      const notifyPromptPromise = manager.sendCommand({ type: 'prompt', message: 'hold-with-notify' })
      const [notifyEvent] = (await notifyEventPromise) as [Record<string, unknown>]
      assert.equal(notifyEvent.method, 'notify')
      t.mock.timers.tick(30_000)
      await assert.rejects(notifyPromptPromise, (err: unknown) => {
        assert.ok(err instanceof RpcTimeoutError)
        assert.equal(err.commandType, 'prompt')
        return true
      })

      // 5. Engine cancellation resumes the deadline timer
      const cancelUiPromise = once(manager, 'extension_ui_request')
      const cancelPromptPromise = manager.sendCommand({ type: 'prompt', message: 'hold-for-cancel' })
      const [cancelUi] = (await cancelUiPromise) as [Record<string, unknown>]
      assert.equal(cancelUi.method, 'select')
      assert.equal(cancelUi.id, 'ui-cancel-1')
      t.mock.timers.tick(35_000)

      // Engine cancels the UI request
      const cancelEventPromise = once(manager, 'extension_ui_request')
      manager.sendCommandFireAndForget({ type: 'trigger-cancel' })
      await cancelEventPromise
      // With UI cancelled, prompt transport timer resumes and expires after 30s
      t.mock.timers.tick(30_000)
      await assert.rejects(cancelPromptPromise, (err: unknown) => {
        assert.ok(err instanceof RpcTimeoutError)
        assert.equal(err.commandType, 'prompt')
        return true
      })

      // 6. Teardown rejects retained prompt waiting on human UI
      const teardownUiPromise = once(manager, 'extension_ui_request')
      const teardownPromptPromise = manager.sendCommand({ type: 'prompt', message: 'hold-for-teardown' })
      const [teardownUiEvent] = (await teardownUiPromise) as [Record<string, unknown>]
      assert.equal(teardownUiEvent.method, 'input')
      t.mock.timers.tick(35_000)

      manager.stop()
      await assert.rejects(teardownPromptPromise, (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(!(err instanceof RpcTimeoutError), 'teardown must reject, not report transport timeout')
        return true
      })
    } finally {
      t.mock.timers.reset()
    }
  }, { FAKE_PI_MODE: 'rpc' })
})


test('the Pi child receives variables from the user env file', SKIP_ON_WINDOWS, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-dotenv-home-'))
  const savedHome = process.env.HOME
  try {
    mkdirSync(dirname(piDotenvPath(home)))
    writeFileSync(piDotenvPath(home), 'FAKE_PI_MODE=late-ready\n')
    process.env.HOME = home
    await withFakeEngine(async (manager, env) => {
      // Without the env file the fake engine stays silent and fails the start.
      const status = await manager.start({ env })
      assert.equal(status.status, 'running')
    }, {})
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

/**
 * Run `run` with process.env as Windows startup leaves it for a user who had
 * not set the current-folder search switch: the app added it. Simulated on
 * POSIX. A spelling this environment already had is put back afterwards.
 */
async function withWindowsStartupEnv(run: () => void | Promise<void>): Promise<void> {
  const key = NO_CWD_EXE_SEARCH_VARIABLE.toLowerCase()
  const inherited = Object.entries(process.env).filter(([name]) => name.toLowerCase() === key)
  for (const [name] of inherited) delete process.env[name]
  disableCwdExecutableSearch(process.env, 'win32')
  try {
    await run()
  } finally {
    delete process.env[NO_CWD_EXE_SEARCH_VARIABLE]
    for (const [name, value] of inherited) process.env[name] = value
    disableCwdExecutableSearch(process.env, process.platform)
  }
}

test('a Pi or OMP run keeps the current-folder search switch only when cmd.exe starts it', () => {
  const base: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\system32' }
  disableCwdExecutableSearch(base, 'win32')
  try {
    assert.equal(NO_CWD_EXE_SEARCH_VARIABLE in buildPiRunEnv(false, base), false, 'direct launch')
    assert.equal(NO_CWD_EXE_SEARCH_VARIABLE in buildPiRunEnv(true, base), true, 'cmd.exe shim launch')
  } finally {
    disableCwdExecutableSearch({}, process.platform)
  }
})

test('a direct Pi start does not hand the current-folder search switch to the engine', SKIP_ON_WINDOWS, async () => {
  // The engine is the user's tool: its own commands must find programs as
  // they do outside the app.
  await withWindowsStartupEnv(() => withFakeEngine(async (manager, env) => {
    const status = await manager.start({ env })
    assert.equal(status.status, 'running', status.error ?? '')
  }, { FAKE_PI_MODE: 'late-ready', FAKE_PI_EXIT_IF_ENV: NO_CWD_EXE_SEARCH_VARIABLE }))
})

test('an engine probe does not hand the current-folder search switch to the engine', SKIP_ON_WINDOWS, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-probe-env-'))
  const script = join(dir, 'fake-omp')
  const forbiddenName = JSON.stringify(NO_CWD_EXE_SEARCH_VARIABLE.toLowerCase())
  writeFileSync(
    script,
    `#!/usr/bin/env node\nconsole.log(Object.keys(process.env).filter((name) => name.toLowerCase() === ${forbiddenName}).length)\n`,
  )
  chmodSync(script, 0o755)
  try {
    await withWindowsStartupEnv(() => {
      const stdout = RESOLUTION_DEPS.capture(script, [], {
        shell: false,
        timeoutMs: TEST_READY_MS,
        pathEnv: process.env.PATH ?? '',
      })
      assert.equal(stdout?.trim(), '0')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectPiInstallations serves a cached scan until a rescan forces a fresh one', () => {
  // The resolver reads process.env live, so a sandbox HOME plus a PATH holding
  // only the fixture directory keeps every search branch inside the temp tree.
  // SHELL points at nothing, so the login-shell probe cannot widen that PATH.
  const dir = mkdtempSync(join(tmpdir(), 'pi-detect-'))
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL }
  try {
    process.env.HOME = dir
    process.env.PATH = dir
    process.env.SHELL = join(dir, 'no-such-shell')
    writeFileSync(join(dir, 'pi'), '')

    const initial = detectPiInstallations(true)
    assert.deepEqual(initial, [{ kind: 'pi', path: join(dir, 'pi'), source: 'path' }])

    // An engine installed after that scan: the cached answer cannot show it.
    writeFileSync(join(dir, 'omp'), '')
    assert.deepEqual(detectPiInstallations(), initial)

    assert.deepEqual(detectPiInstallations(true), [
      { kind: 'pi', path: join(dir, 'pi'), source: 'path' },
      { kind: 'omp', path: join(dir, 'omp'), source: 'omp' },
    ])
  } finally {
    process.env.HOME = saved.HOME
    process.env.PATH = saved.PATH
    if (saved.SHELL === undefined) delete process.env.SHELL
    else process.env.SHELL = saved.SHELL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RpcTimeoutError is identified by class, not by message text', () => {
  const error = new RpcTimeoutError('get_state', 30_000)
  assert.ok(error instanceof RpcTimeoutError)
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'RpcTimeoutError')
  assert.equal(error.commandType, 'get_state')
})
