import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { commitAll, listLocalBranches, switchLocalBranch } from './git-conveyor'

async function withRepo(fn: (repo: string, git: (args: string[]) => string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'pi-branch-switch-'))
  const git = (args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    git(['init'])
    git(['config', 'user.email', 'pi-desktop@example.test'])
    git(['config', 'user.name', 'Pi Desktop Tests'])
    await fn(repo, git)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

test('switching carries compatible changes and subsequent commits target the chosen branch', async () => {
  await withRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.txt'), 'original\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    const initial = git(['branch', '--show-current'])
    git(['branch', 'feature/nested'])
    await writeFile(join(repo, 'app.txt'), 'local changes\n')
    await writeFile(join(repo, 'untracked.txt'), 'untracked\n')
    git(['add', 'app.txt'])
    const index = git(['write-tree'])
    assert.equal((await switchLocalBranch(repo, 'feature/nested')).branch, 'feature/nested')
    assert.equal(git(['write-tree']), index)
    assert.equal(await readFile(join(repo, 'untracked.txt'), 'utf8'), 'untracked\n')
    await commitAll(repo, { message: 'selected branch commit' })
    assert.equal(git(['log', '-1', '--format=%s', 'feature/nested']), 'selected branch commit')
    assert.equal(git(['log', '-1', '--format=%s', initial]), 'initial')
  })
})

for (const change of ['staged', 'unstaged', 'untracked']) {
  test(`switching refuses to overwrite ${change} content`, async () => {
    await withRepo(async (repo, git) => {
      await writeFile(join(repo, 'base.txt'), 'base\n')
      if (change !== 'untracked') await writeFile(join(repo, 'app.txt'), 'original\n')
      git(['add', '.'])
      git(['commit', '-m', 'initial'])
      const initial = git(['branch', '--show-current'])
      git(['switch', '-c', 'target'])
      await writeFile(join(repo, 'app.txt'), 'target content\n')
      git(['add', '.'])
      git(['commit', '-m', 'target'])
      git(['switch', initial])
      await writeFile(join(repo, 'app.txt'), 'local changes\n')
      if (change === 'staged') git(['add', 'app.txt'])
      const index = git(['write-tree'])
      await assert.rejects(switchLocalBranch(repo, 'target'), /overwritten/i)
      assert.equal(git(['branch', '--show-current']), initial)
      assert.equal(git(['write-tree']), index)
      assert.equal(await readFile(join(repo, 'app.txt'), 'utf8'), 'local changes\n')
      assert.equal(git(['stash', 'list']), '')
    })
  })
}

test('only local branches are accepted, including branch/tag collisions and detached HEAD recovery', async () => {
  await withRepo(async (repo, git) => {
    assert.deepEqual(await listLocalBranches(repo), [])
    git(['commit', '--allow-empty', '-m', 'initial'])
    const initial = git(['branch', '--show-current'])
    git(['branch', 'feature/nested'])
    git(['tag', 'feature/nested'])
    git(['update-ref', 'refs/remotes/origin/remote-only', 'HEAD'])
    assert.deepEqual(await listLocalBranches(repo), [initial, 'feature/nested'].sort())
    for (const branch of ['remote-only', 'origin/remote-only', 'HEAD', '@{-1}', '--detach', '', 'missing']) {
      await assert.rejects(switchLocalBranch(repo, branch), /existing local branch/)
      assert.equal(git(['branch', '--show-current']), initial)
    }
    git(['switch', '--detach'])
    assert.equal((await switchLocalBranch(repo, 'feature/nested')).branch, 'feature/nested')
  })
})

test('switching refuses active Git operations and branches held by another worktree', async () => {
  await withRepo(async (repo, git) => {
    git(['commit', '--allow-empty', '-m', 'initial'])
    const initial = git(['branch', '--show-current'])
    git(['branch', 'target'])
    await writeFile(join(repo, '.git', 'MERGE_HEAD'), `${git(['rev-parse', 'HEAD'])}\n`)
    await assert.rejects(switchLocalBranch(repo, 'target'), /merge.*in progress/)
    await rm(join(repo, '.git', 'MERGE_HEAD'))
    git(['worktree', 'add', join(repo, 'other-worktree'), 'target'])
    await assert.rejects(switchLocalBranch(repo, 'target'), /already (?:used|checked out)/)
    assert.equal(git(['branch', '--show-current']), initial)
  })
})
