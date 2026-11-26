import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

const HELPER_URL = new URL('./temp-dir.test-helper.ts', import.meta.url).href
const CHILD_TIMEOUT_MS = 30_000
const EXIT_FAILURE = 1

/** Run a child process that makes a temp folder, then exits with `exitCode`; returns the folder path. */
function tempDirOfChildThatExits(exitCode: number): { dir: string; status: number | null } {
  const script = [
    `import { existsSync } from 'node:fs'`,
    `import { makeTempDir } from ${JSON.stringify(HELPER_URL)}`,
    `const dir = makeTempDir('pi-temp-dir-test-')`,
    `if (!existsSync(dir)) throw new Error('the folder was not made')`,
    `process.stdout.write(dir)`,
    `process.exitCode = ${exitCode}`,
  ].join('\n')
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL',
  })
  assert.equal(result.error, undefined, result.stderr)
  return { dir: result.stdout, status: result.status }
}

test('a temp folder is removed when the test process exits', () => {
  const { dir, status } = tempDirOfChildThatExits(0)
  assert.equal(status, 0)
  assert.notEqual(dir, '')
  assert.equal(existsSync(dir), false)
})

test('a temp folder is removed when the tests of that process fail', () => {
  const { dir, status } = tempDirOfChildThatExits(EXIT_FAILURE)
  assert.equal(status, EXIT_FAILURE)
  assert.notEqual(dir, '')
  assert.equal(existsSync(dir), false)
})
