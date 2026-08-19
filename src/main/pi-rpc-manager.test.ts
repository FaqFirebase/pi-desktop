import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPiInvocation, type PiCli } from './pi-rpc-manager'

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
