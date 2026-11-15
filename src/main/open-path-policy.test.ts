import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Workspace } from '../shared/ipc-contracts'
import {
  RUNNABLE_EXTENSIONS,
  extensionsForPolicy,
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

test('Windows and macOS types that run through the system are on the blocklist', () => {
  for (const ext of ['.pif', '.scf', '.application', '.appref-ms', '.vb', '.ws', '.wsc', '.msp', '.reg', '.settingcontent-ms', '.library-ms', '.fileloc', '.prefpane']) {
    assert.equal(RUNNABLE_EXTENSIONS.has(ext), true, ext)
    assert.equal(isRunnableTarget([`/p/a${ext}`], plainFile, 'linux'), true, ext)
  }
})

test('a stream name after a colon does not hide the extension', () => {
  assert.deepEqual(extensionsForPolicy('C:\\p\\run.bat::$DATA'), ['.bat::$data', '.bat'])
  assert.deepEqual(extensionsForPolicy('/p/run.sh:notes.txt'), ['.txt', '.sh'])
  assert.equal(isRunnableTarget(['C:\\p\\run.bat::$DATA'], plainFile, 'win32'), true)
  assert.equal(isRunnableTarget(['/p/run.sh:x.txt'], plainFile, 'linux'), true)
})

test('a colon in a POSIX name does not hide the full name extension', () => {
  assert.equal(isRunnableTarget(['/p/notes:run.sh'], plainFile, 'linux'), true)
  assert.equal(isRunnableTarget(['/p/a:b.jar'], plainFile, 'linux'), true)
  assert.equal(isRunnableTarget(['/p/x:y.desktop'], plainFile, 'linux'), true)
  assert.equal(isRunnableTarget(['/Apps/X:Y.app'], { isFile: false, mode: 0o755 }, 'darwin'), true)
  assert.equal(isRunnableTarget(['/p/notes:draft.txt'], plainFile, 'linux'), false)
})

test('extensionsForPolicy drops trailing dots and spaces and folds case', () => {
  assert.deepEqual(extensionsForPolicy('C:\\p\\SETUP.EXE'), ['.exe'])
  assert.deepEqual(extensionsForPolicy('/p/run.bat. .'), ['.bat'])
  assert.deepEqual(extensionsForPolicy('/p/README'), [''])
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
