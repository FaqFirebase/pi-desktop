import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoSetStore, inspectRepoFolder, validateRepoSetDraft } from './repo-sets'

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  assert.equal(result.status, 0, result.stderr)
}

/** A git repository with one commit, in a fresh temporary folder. */
async function repository(name: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'pi-repo-set-')), name)
  await mkdir(join(path, 'src'), { recursive: true })
  await writeFile(join(path, 'README.md'), name, 'utf-8')
  git(['init'], path)
  git(['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'add', '.'], path)
  git(['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-m', 'initial'], path)
  return path
}

test('a folder inside a repository resolves to the top of its checkout', async () => {
  const repo = await repository('shop-lib')
  const folder = await inspectRepoFolder(join(repo, 'src'))
  assert.equal(folder.name, 'shop-lib')
  assert.equal(await readFile(join(folder.path, 'README.md'), 'utf-8'), 'shop-lib')
})

test('a folder outside git or a missing folder is refused with a readable error', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'pi-not-repo-'))
  await assert.rejects(inspectRepoFolder(plain), /not in a git repository/)
  await assert.rejects(inspectRepoFolder(join(plain, 'gone')), /does not exist/)
})

test('validateRepoSetDraft trims names and refuses a folder listed two times', () => {
  const draft = validateRepoSetDraft({
    name: ' Shop ',
    members: [
      { name: ' app ', sourcePath: '/src/app', role: 'main' },
      { name: 'lib', sourcePath: '/src/lib', role: 'linked' },
    ],
  })
  assert.equal(draft.name, 'Shop')
  assert.equal(draft.members[0].name, 'app')
  assert.throws(() => validateRepoSetDraft({
    name: 'Shop',
    members: [
      { name: 'app', sourcePath: '/src/app', role: 'main' },
      { name: 'again', sourcePath: '/src/app/', role: 'linked' },
    ],
  }), /two times/)
})

test('the store saves, updates, lists, and deletes sets, and keeps them across a restart', async () => {
  const app = await repository('shop-app')
  const lib = await repository('shop-lib')
  const file = join(await mkdtemp(join(tmpdir(), 'pi-repo-sets-')), 'repo-sets.json')
  const store = new RepoSetStore(file)

  const saved = await store.save({
    name: 'Shop',
    members: [
      { name: 'shop-app', sourcePath: join(app, 'src'), role: 'main' },
      { name: 'shop-lib', sourcePath: lib, role: 'linked' },
    ],
  })
  assert.equal(saved.members[0].sourcePath.endsWith('shop-app'), true, 'a subfolder is stored as its checkout')

  const renamed = await store.save({ ...saved, name: 'Shop 2' })
  assert.equal(renamed.id, saved.id)
  assert.equal(renamed.createdAt, saved.createdAt)

  const reopened = new RepoSetStore(file)
  assert.deepEqual((await reopened.list()).map((set) => set.name), ['Shop 2'])
  await reopened.delete(saved.id)
  assert.deepEqual(await new RepoSetStore(file).list(), [])
  await assert.rejects(reopened.get(saved.id), /no longer exists/)
})

test('two checkouts of one repository cannot be in the same set', async () => {
  const app = await repository('shop-app')
  const worktree = join(await mkdtemp(join(tmpdir(), 'pi-wt-')), 'second')
  git(['worktree', 'add', '-b', 'second', worktree], app)
  const store = new RepoSetStore(join(await mkdtemp(join(tmpdir(), 'pi-repo-sets-')), 'repo-sets.json'))
  await assert.rejects(store.save({
    name: 'Shop',
    members: [
      { name: 'one', sourcePath: app, role: 'main' },
      { name: 'two', sourcePath: worktree, role: 'linked' },
    ],
  }), /second checkout/)
})
