import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileService } from './file-service'
import { splitGitDiff } from '../shared/git-diff'

async function repo(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'pi-discard-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: path, encoding: 'utf8' })
  git('init', '-q')
  await writeFile(join(path, 'a.txt'), 'original\n')
  await writeFile(join(path, 'b.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  return { path, git, service: new FileService(path) }
}

test('discards a single reviewed file, preserving hidden changes and the index', async (t) => {
  const { path, git, service } = await repo(t)
  await writeFile(join(path, 'a.txt'), 'staged\n')
  git('add', 'a.txt')
  const staged = git('diff', '--cached')
  await writeFile(join(path, 'a.txt'), 'working\n')
  await writeFile(join(path, 'b.txt'), 'hidden\n')
  await service.discardFileDiff(splitGitDiff(await service.getFileDiff('a.txt')))
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'staged\n')
  assert.equal(await readFile(join(path, 'b.txt'), 'utf8'), 'hidden\n')
  assert.equal(git('diff', '--cached'), staged)
})

test('batch discard restores deletions and removes new files including empty/no-newline files', async (t) => {
  const { path, service } = await repo(t)
  await rm(join(path, 'a.txt'))
  for (const [name, content] of [['empty', ''], ['no-newline', 'text'], ['spaces', '  \n']]) {
    await writeFile(join(path, name), content)
  }
  await service.discardFileDiff(splitGitDiff(await service.getFileDiff()))
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'original\n')
  for (const name of ['empty', 'no-newline', 'spaces']) {
    await assert.rejects(readFile(join(path, name)), { code: 'ENOENT' })
  }
})

test('stale or tampered batches leave every file unchanged', async (t) => {
  const { path, service } = await repo(t)
  await writeFile(join(path, 'a.txt'), 'first\n')
  await writeFile(join(path, 'b.txt'), 'first\n')
  const patches = splitGitDiff(await service.getFileDiff())
  await writeFile(join(path, 'b.txt'), 'newer\n')
  await assert.rejects(service.discardFileDiff(patches))
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'first\n')
  assert.equal(await readFile(join(path, 'b.txt'), 'utf8'), 'newer\n')
  await assert.rejects(service.discardFileDiff([patches[0].replace('+first', '+injected')]))
})

test('new-file newline changes are stale, not silently discarded', async (t) => {
  const { path, service } = await repo(t)
  await writeFile(join(path, 'new.txt'), 'text')
  const patches = splitGitDiff(await service.getFileDiff())
  await writeFile(join(path, 'new.txt'), 'text\n')
  await assert.rejects(service.discardFileDiff(patches))
  assert.equal(await readFile(join(path, 'new.txt'), 'utf8'), 'text\n')
})

test('unsupported binary files fail the entire batch', async (t) => {
  const { path, service } = await repo(t)
  await writeFile(join(path, 'a.txt'), 'changed\n')
  await writeFile(join(path, 'binary'), Buffer.from([0, 255, 1]))
  await assert.rejects(service.discardFileDiff(splitGitDiff(await service.getFileDiff())))
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'changed\n')
})

test('symlink targets outside the workspace are never discarded', { skip: process.platform === 'win32' }, async (t) => {
  const { path, service } = await repo(t)
  const outside = await mkdtemp(join(tmpdir(), 'pi-discard-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'secret'), 'keep\n')
  await symlink(join(outside, 'secret'), join(path, 'link'))
  await assert.rejects(service.discardFileDiff(splitGitDiff(await service.getFileDiff())))
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'keep\n')
})

test('a subdirectory workspace cannot discard changes in the parent repo', async (t) => {
  const { path, git } = await repo(t)
  await mkdir(join(path, 'sub'))
  await writeFile(join(path, 'sub', 'inner.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'subdirectory')
  await writeFile(join(path, 'sub', 'inner.txt'), 'changed\n')
  await writeFile(join(path, 'a.txt'), 'outside workspace\n')
  const service = new FileService(join(path, 'sub'))
  const patches = splitGitDiff(await service.getFileDiff())
  await assert.rejects(service.discardFileDiff(patches), /outside the active workspace/)
  await service.discardFileDiff(patches.filter((patch) => patch.startsWith('diff --git a/sub/')))
  assert.equal(await readFile(join(path, 'sub', 'inner.txt'), 'utf8'), 'original\n')
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'outside workspace\n')
})

test('refuses empty, duplicate and foreign patches', async (t) => {
  const { path, service } = await repo(t)
  await writeFile(join(path, 'a.txt'), 'changed\n')
  const patches = splitGitDiff(await service.getFileDiff())
  await assert.rejects(service.discardFileDiff([]))
  await assert.rejects(service.discardFileDiff([...patches, ...patches]))
  await assert.rejects(service.discardFileDiff([patches[0].replaceAll('a.txt', '../outside')]))
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'changed\n')
})
