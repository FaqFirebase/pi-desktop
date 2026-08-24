import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPiArgs,
  buildPiInvocation,
  detectPiInstallations,
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
