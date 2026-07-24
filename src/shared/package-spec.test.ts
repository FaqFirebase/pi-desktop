import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isValidPackageSpec } from './package-spec'

test('accepts a scoped npm spec with version', () => {
  assert.equal(isValidPackageSpec('npm:@earendil/pi-free@1.2.3'), true)
})

test('accepts a bare npm spec and a dist-tag', () => {
  assert.equal(isValidPackageSpec('npm:pi-ollama-cloud@latest'), true)
  assert.equal(isValidPackageSpec('left-pad'), true)
  assert.equal(isValidPackageSpec('@scope/name'), true)
})

test('accepts a git source with a ref', () => {
  assert.equal(isValidPackageSpec('git:github.com/user/repo@main'), true)
})

test('rejects an empty or whitespace spec', () => {
  assert.equal(isValidPackageSpec(''), false)
  assert.equal(isValidPackageSpec('   '), false)
  assert.equal(isValidPackageSpec('npm:foo bar'), false)
})

test('rejects shell metacharacters that enable command injection', () => {
  for (const spec of [
    'foo; rm -rf ~',
    'foo && calc',
    'foo | tee x',
    'foo`id`',
    'foo$(id)',
    'foo > out',
    'foo\nbar',
    'foo"bar',
    "foo'bar",
    'foo\\bar',
    'foo%PATH%',
    'foo^bar',
  ]) {
    assert.equal(isValidPackageSpec(spec), false, `expected reject: ${JSON.stringify(spec)}`)
  }
})

test('rejects a spec that starts like a CLI flag', () => {
  assert.equal(isValidPackageSpec('-rf'), false)
  assert.equal(isValidPackageSpec('--force'), false)
})

test('rejects an over-long spec', () => {
  assert.equal(isValidPackageSpec(`npm:${'a'.repeat(300)}`), false)
})
