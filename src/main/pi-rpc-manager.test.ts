import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPiArgs,
  buildPiInvocation,
  detectPiInstallations,
  PiRpcManager,
  resolveStartCli,
  RpcFrameDecoder,
  setPiExecutableOverride,
  type PiCli,
} from './pi-rpc-manager'

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
  const dir = mkdtempSync(join(tmpdir(), 'pi-engine-missing-'))
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

// ─── Startup deadline behavior (issue #58) ──────────────────────────────────
//
// The engine runs every extension session_start hook before it reads stdin, so
// a hook that waits on a local model server keeps the readiness probe
// unanswered for tens of seconds while the process is demonstrably alive.
// The deadline is therefore two-staged: a short cap while stdout is silent
// (dead spawn / broken pipe), a long cap once stdout has shown life.

/** Fast test caps — real values are 20s / 120s. */
const TEST_SILENCE_MS = 400
const TEST_ENGINE_BUSY_MS = 2_000
/** Probe id the manager correlates on; fixed by the wire protocol. */
const PROBE_ID = '__startup_probe__'
/** Fixture heartbeat: proves liveness well within the silence cap. */
const HEARTBEAT_MS = 100
/** Late-ready fixture answers between the two caps. */
const LATE_READY_DELAY_MS = 900
const SKIP_ON_WINDOWS = { skip: process.platform === 'win32' ? 'POSIX shebang fixture' : false }

/**
 * A stand-in engine. Modes via FAKE_PI_MODE:
 *  - 'silent'     — stays alive, never writes stdout.
 *  - 'late-ready' — emits frames immediately, answers the probe only after
 *                   FAKE_PI_READY_DELAY_MS.
 *  - 'never-ready' — emits frames forever, never answers the probe.
 */
const FAKE_ENGINE_SOURCE = `#!/usr/bin/env node
const mode = process.env.FAKE_PI_MODE || 'silent'
const readyDelayMs = Number(process.env.FAKE_PI_READY_DELAY_MS || '0')
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
if (mode !== 'silent') {
  emit({ type: 'extension_ui_request', id: 'boot', method: 'setStatus', statusKey: 'boot', statusText: 'loading' })
  setInterval(() => emit({ type: 'extension_ui_request', id: 'hb', method: 'setStatus', statusKey: 'hb', statusText: 'busy' }), ${HEARTBEAT_MS})
  if (mode === 'late-ready') {
    setTimeout(() => emit({ id: '${PROBE_ID}', type: 'response', command: 'get_state', success: true }), readyDelayMs)
  }
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
  setPiExecutableOverride(script, 'pi')
  const manager = new PiRpcManager({ silenceMs: TEST_SILENCE_MS, engineBusyMs: TEST_ENGINE_BUSY_MS })
  try {
    await run(manager, env)
  } finally {
    manager.stop()
    setPiExecutableOverride(null, 'auto')
    rmSync(dir, { recursive: true, force: true })
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('startup keeps waiting past the silence cap while Pi is emitting output', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(async (manager, env) => {
    const phases: string[] = []
    manager.on('startup-phase', (phase: string) => phases.push(phase))

    const started = manager.start({ env })
    // Between the caps: the silence deadline has passed, readiness has not
    // arrived, and stdout activity must have switched the manager to waiting.
    await delay(TEST_SILENCE_MS + 200)
    assert.equal(manager.getStatus().status, 'starting', 'still starting between the caps')
    assert.equal(manager.getStatus().startupPhase, 'waiting-on-engine')
    assert.deepEqual(phases, ['waiting-on-engine'], 'the phase flip is announced once')

    const status = await started
    assert.equal(status.status, 'running', 'a late probe response still means ready')
    assert.equal(status.startupPhase, undefined, 'phase reporting ends with startup')
  }, { FAKE_PI_MODE: 'late-ready', FAKE_PI_READY_DELAY_MS: String(LATE_READY_DELAY_MS) })
})

test('a silent Pi still fails fast at the silence cap', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(async (manager, env) => {
    const startedAt = Date.now()
    const status = await manager.start({ env })
    assert.equal(status.status, 'error')
    assert.match(status.error ?? '', /produced no output within 0\.4s/)
    // The old message asserted two specific causes that misdiagnosed issue
    // #58 for days; the error must not name them any more.
    assert.doesNotMatch(status.error ?? '', /shell:true|waiting on input/)
    assert.ok(
      Date.now() - startedAt < TEST_ENGINE_BUSY_MS,
      'silence must not inherit the long engine-busy cap',
    )
  }, { FAKE_PI_MODE: 'silent' })
})

test('a chatty but never-ready Pi fails at the engine-busy cap with an engine-busy error', SKIP_ON_WINDOWS, async () => {
  await withFakeEngine(async (manager, env) => {
    const startedAt = Date.now()
    const status = await manager.start({ env })
    assert.equal(status.status, 'error')
    assert.ok(
      Date.now() - startedAt >= TEST_ENGINE_BUSY_MS - HEARTBEAT_MS,
      'the full engine-busy cap is granted before giving up',
    )
    assert.match(status.error ?? '', /did not become ready within 2s/)
    assert.match(status.error ?? '', /model server/, 'the message points at the real cause class')
    assert.equal(status.startupPhase, undefined, 'phase reporting ends with startup')
  }, { FAKE_PI_MODE: 'never-ready' })
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
