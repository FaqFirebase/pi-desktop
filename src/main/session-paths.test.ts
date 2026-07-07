import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  sanitizePath,
  sessionDirName,
  desanitizeSessionDir,
  projectNameFromPath,
  pathsEqual,
} from './session-paths'

test('sanitizePath encodes POSIX paths like Pi', () => {
  assert.equal(sanitizePath('/home/alice'), '--home-alice--')
  assert.equal(sanitizePath('/home/alice/Projects/app'), '--home-alice-Projects-app--')
})

test('sanitizePath encodes Windows paths (drive colon + backslashes)', () => {
  assert.equal(sanitizePath('C:\\Users\\UPN'), '--C--Users-UPN--')
  assert.equal(
    sanitizePath('C:\\Users\\UPN\\documents\\workday'),
    '--C--Users-UPN-documents-workday--'
  )
})

test('sanitizePath(workspace) matches the on-disk Windows session dir', () => {
  // Regression: workspace match used to fail on Windows, leaking the raw slug.
  const wsPath = 'C:\\Users\\UPN\\documents\\workday'
  const onDiskDir = '--C--Users-UPN-documents-workday--'
  assert.equal(sanitizePath(wsPath), onDiskDir)
})

test('sessionDirName strips the root and a leading backslash', () => {
  const root = 'C:\\Users\\UPN\\.pi\\agent\\sessions'
  const dir = 'C:\\Users\\UPN\\.pi\\agent\\sessions\\--C--Users-UPN-documents-workday--'
  assert.equal(sessionDirName(dir, root), '--C--Users-UPN-documents-workday--')
})

test('sessionDirName strips the root and a leading forward slash', () => {
  const root = '/home/alice/.pi/agent/sessions'
  const dir = '/home/alice/.pi/agent/sessions/--home-alice--'
  assert.equal(sessionDirName(dir, root), '--home-alice--')
})

test('desanitizeSessionDir reverses POSIX names', () => {
  assert.equal(desanitizeSessionDir('--home-alice--'), '/home/alice')
})

test('desanitizeSessionDir rebuilds a native Windows path (drive signature)', () => {
  // Regression: must produce "C:\..." — not "/C/..." — so the decoded path
  // stays valid when reused as a workspace path.
  assert.equal(desanitizeSessionDir('--C--Users-UPN--'), 'C:\\Users\\UPN')
  assert.equal(
    desanitizeSessionDir('--C--Users-UPN-documents-workday--'),
    'C:\\Users\\UPN\\documents\\workday'
  )
})

test('desanitizeSessionDir handles a bare Windows drive root', () => {
  assert.equal(desanitizeSessionDir('--C----'), 'C:\\')
})

test('desanitizeSessionDir passes through non-sanitized input', () => {
  assert.equal(desanitizeSessionDir('not-a-session-dir'), 'not-a-session-dir')
})

test('projectNameFromPath returns the basename regardless of separator', () => {
  assert.equal(projectNameFromPath('C:\\Users\\UPN\\documents\\workday'), 'workday')
  assert.equal(projectNameFromPath('/home/alice/app'), 'app')
  assert.equal(projectNameFromPath('/C/Users/UPN/documents/workday'), 'workday')
})

test('pathsEqual ignores case when case-insensitive (Windows)', () => {
  assert.equal(
    pathsEqual('C:\\Users\\UPN\\Documents\\workday', 'C:\\Users\\UPN\\documents\\workday', true),
    true
  )
  // Also works for encoded session-dir names.
  assert.equal(pathsEqual('--C--Users-UPN-Documents-workday--', '--C--Users-UPN-documents-workday--', true), true)
  assert.equal(pathsEqual('C:\\a', 'C:\\b', true), false)
})

test('pathsEqual is exact when case-sensitive (Linux/macOS)', () => {
  // Regression guard: must NOT change behavior on case-sensitive systems.
  assert.equal(pathsEqual('/home/alice/App', '/home/alice/app', false), false)
  assert.equal(pathsEqual('/home/alice/app', '/home/alice/app', false), true)
})
