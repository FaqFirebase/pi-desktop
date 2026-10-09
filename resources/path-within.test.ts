import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isPathWithin, resolveRealPath } from './path-within'

// Windows needs elevation for symlinks; the checks stay POSIX-tested.
const SKIP_WITHOUT_SYMLINKS = process.platform === 'win32'

test('isPathWithin follows the Windows rules on win32: drive letter case, both separators, UNC', () => {
  assert.equal(isPathWithin('C:\\Repo', 'c:\\repo\\src\\a.ts', 'win32'), true)
  assert.equal(isPathWithin('C:\\Repo', 'C:/Repo/src/a.ts', 'win32'), true)
  assert.equal(isPathWithin('c:/repo/', 'C:\\Repo', 'win32'), true)
  assert.equal(isPathWithin('C:\\Repo', 'D:\\Repo\\a.ts', 'win32'), false)
  assert.equal(isPathWithin('C:\\Repo', 'C:\\Repo-secrets\\a.ts', 'win32'), false)
  assert.equal(isPathWithin('\\\\server\\share\\repo', '\\\\SERVER\\Share\\repo\\a.ts', 'win32'), true)
  assert.equal(isPathWithin('\\\\server\\share\\repo', '//server/share/repo/a.ts', 'win32'), true)
  assert.equal(isPathWithin('\\\\server\\share\\repo', '\\\\server\\other\\repo\\a.ts', 'win32'), false)
  assert.equal(isPathWithin('/repo', '/Repo/a.ts', 'linux'), false)
})

test('resolveRealPath follows the symlinks in the part that exists and keeps the missing rest', { skip: SKIP_WITHOUT_SYMLINKS }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'path-within-')))
  try {
    const target = join(root, 'target')
    await mkdir(target)
    await symlink(target, join(root, 'link'), 'dir')
    await writeFile(join(root, 'file.txt'), 'x')
    assert.equal(resolveRealPath(join(root, 'link')), target)
    assert.equal(resolveRealPath(join(root, 'link', 'new', 'a.txt')), join(target, 'new', 'a.txt'))
    // A file where a folder should be: the path cannot exist, the folder part is still real.
    assert.equal(resolveRealPath(join(root, 'file.txt', 'a.txt')), join(root, 'file.txt', 'a.txt'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveRealPath gives null when the real location cannot be known', { skip: SKIP_WITHOUT_SYMLINKS }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'path-within-')))
  try {
    // A dangling link: a write through it creates the missing target, wherever it is.
    await symlink(join(root, 'missing'), join(root, 'dangling'))
    assert.equal(resolveRealPath(join(root, 'dangling')), null)
    assert.equal(resolveRealPath(join(root, 'dangling', 'a.txt')), null)
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'))
    assert.equal(resolveRealPath(join(root, 'loop-a', 'a.txt')), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
