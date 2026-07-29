import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathGroupKey, pathsEqual, isPathCaseInsensitive } from './path-compare'

test('pathsEqual matches exact paths (case-sensitive mode)', () => {
  assert.equal(pathsEqual('/home/alice/App', '/home/alice/App', false), true)
  assert.equal(pathsEqual('/home/alice/App', '/home/alice/app', false), false)
})

test('pathsEqual folds case when case-insensitive (Windows mode)', () => {
  assert.equal(
    pathsEqual('C:\\Users\\UPN\\Documents\\workday', 'C:\\Users\\UPN\\documents\\workday', true),
    true
  )
  assert.equal(pathsEqual('C:\\a', 'C:\\b', true), false)
})

test('pathsEqual strips a single trailing separator', () => {
  assert.equal(pathsEqual('/home/alice/proj/', '/home/alice/proj', false), true)
  assert.equal(pathsEqual('C:\\work\\repo\\', 'C:\\work\\repo', true), true)
  assert.equal(pathsEqual('/a/b/', '/a/c', false), false)
})

test('pathGroupKey folds only in case-insensitive mode', () => {
  assert.equal(pathGroupKey('C:\\Work\\Repo', true), 'c:\\work\\repo')
  assert.equal(pathGroupKey('/Home/Alice', false), '/Home/Alice')
  assert.equal(pathGroupKey('/Home/Alice/', false), '/Home/Alice')
})

test('isPathCaseInsensitive honors explicit override', () => {
  assert.equal(isPathCaseInsensitive(true), true)
  assert.equal(isPathCaseInsensitive(false), false)
})

test('isPathCaseInsensitive uses Node process.platform when no bridge', () => {
  // Node test runner has process.platform; matches host OS.
  assert.equal(isPathCaseInsensitive(), process.platform === 'win32')
})
