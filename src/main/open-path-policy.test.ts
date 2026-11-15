import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Workspace } from '../shared/ipc-contracts'
import {
  RUNNABLE_EXTENSIONS,
  extensionForPolicy,
  isRunnableTarget,
  openPathRoots,
  resolveOpenPathTarget,
} from './open-path-policy'

const plainFile = { isFile: true, mode: 0o644 }

test('every spec extension is on the blocklist', () => {
  for (const ext of ['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl', '.msc', '.lnk', '.url', '.jar', '.app', '.command', '.tool', '.terminal', '.workflow', '.action', '.pkg', '.mpkg', '.scpt', '.applescript', '.desktop', '.appimage', '.sh']) {
    assert.equal(RUNNABLE_EXTENSIONS.has(ext), true, ext)
  }
})

test('extensionForPolicy drops trailing dots and spaces and folds case', () => {
  assert.equal(extensionForPolicy('C:\\p\\SETUP.EXE'), '.exe')
  assert.equal(extensionForPolicy('/p/run.bat. .'), '.bat')
  assert.equal(extensionForPolicy('/p/README'), '')
})

test('Windows name tricks are still runnable', () => {
  for (const name of ['C:\\p\\SETUP.EXE', 'C:\\p\\run.bat.', 'C:\\p\\run.bat ', 'C:\\p\\a.txt.cmd']) {
    assert.equal(isRunnableTarget([name], plainFile, 'win32'), true, name)
  }
})

test('a plain text file is not runnable', () => {
  assert.equal(isRunnableTarget(['/p/notes.txt'], plainFile, 'linux'), false)
})

test('an execute bit makes a file runnable on macOS and Linux', () => {
  assert.equal(isRunnableTarget(['/p/tool'], { isFile: true, mode: 0o755 }, 'linux'), true)
  assert.equal(isRunnableTarget(['/p/tool'], { isFile: true, mode: 0o744 }, 'darwin'), true)
})

test('Windows ignores the execute bit', () => {
  assert.equal(isRunnableTarget(['C:\\p\\notes.txt'], { isFile: true, mode: 0o755 }, 'win32'), false)
})

test('a folder with execute bits is not runnable, a bundle folder is', () => {
  assert.equal(isRunnableTarget(['/p/src'], { isFile: false, mode: 0o755 }, 'linux'), false)
  assert.equal(isRunnableTarget(['/Applications/X.app'], { isFile: false, mode: 0o755 }, 'darwin'), true)
})

test('a harmless name that links to a script is runnable', () => {
  assert.equal(isRunnableTarget(['/p/notes.txt', '/p/run.sh'], plainFile, 'linux'), true)
})

test('containment rejects prefix siblings and traversal', () => {
  const roots = ['/a/project']
  assert.equal(resolveOpenPathTarget('/a/project/src/x.ts', null, roots, 'linux'), '/a/project/src/x.ts')
  assert.equal(resolveOpenPathTarget('  /a/project/src/x.ts ', null, roots, 'linux'), '/a/project/src/x.ts')
  assert.equal(resolveOpenPathTarget('/a/project-secrets/k', null, roots, 'linux'), null)
  assert.equal(resolveOpenPathTarget('/a/project/../etc/passwd', null, roots, 'linux'), null)
})

test('a relative tool path resolves against the panel root', () => {
  assert.equal(resolveOpenPathTarget('src/x.ts', '/a/project', ['/a/project'], 'linux'), '/a/project/src/x.ts')
  assert.equal(resolveOpenPathTarget('src/x.ts', null, ['/a/project'], 'linux'), null)
  assert.equal(resolveOpenPathTarget('../other/x.ts', '/a/project', ['/a/project'], 'linux'), null)
})

test('Windows containment folds case', () => {
  assert.equal(resolveOpenPathTarget('c:\\Repo\\a.ts', null, ['C:\\repo'], 'win32'), 'c:\\Repo\\a.ts')
})

test('roots include linked repos, session stores and session folders', () => {
  const ws = { id: 'w', name: 'w', path: '/w', createdAt: 0, lastActiveAt: 0, color: '', linkedTask: { setId: 's', setName: 's', mode: 'worktree', repos: [{ workPath: '/r2' }] } } as unknown as Workspace
  assert.deepEqual(openPathRoots([ws], ['/h/.pi/agent/sessions'], new Set(['/f'])), ['/w', '/r2', '/h/.pi/agent/sessions', '/f'])
})
