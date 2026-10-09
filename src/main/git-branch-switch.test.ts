import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { GitSwitchRefusal, commitAll, listLocalBranches, switchLocalBranch } from './git-conveyor'

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

test('a clean switch makes subsequent commits target the chosen branch', async () => {
  await withRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.txt'), 'original\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    const initial = git(['branch', '--show-current'])
    git(['branch', 'feature/nested'])
    assert.equal((await switchLocalBranch(repo, 'feature/nested')).branch, 'feature/nested')
    await writeFile(join(repo, 'app.txt'), 'selected branch change\n')
    await commitAll(repo, { message: 'selected branch commit' })
    assert.equal(git(['log', '-1', '--format=%s', 'feature/nested']), 'selected branch commit')
    assert.equal(git(['log', '-1', '--format=%s', initial]), 'initial')
  })
})

for (const change of ['staged', 'unstaged', 'untracked']) {
  test(`switching refuses a worktree with ${change} changes and leaves it untouched`, async () => {
    await withRepo(async (repo, git) => {
      await writeFile(join(repo, 'app.txt'), 'original\n')
      git(['add', '.'])
      git(['commit', '-m', 'initial'])
      const initial = git(['branch', '--show-current'])
      git(['branch', 'target'])
      const changedFile = change === 'untracked' ? 'new.txt' : 'app.txt'
      await writeFile(join(repo, changedFile), 'local changes\n')
      if (change === 'staged') git(['add', changedFile])
      const index = git(['write-tree'])
      await assert.rejects(switchLocalBranch(repo, 'target'), /Commit or discard/)
      assert.equal(git(['branch', '--show-current']), initial)
      assert.equal(git(['write-tree']), index)
      assert.equal(await readFile(join(repo, changedFile), 'utf8'), 'local changes\n')
      assert.equal(git(['stash', 'list']), '')
    })
  })
}

test('switching refuses to overwrite an ignored file that the target branch tracks, and names it', async () => {
  await withRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.txt'), 'original\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    const initial = git(['branch', '--show-current'])
    git(['switch', '--create', 'old-config'])
    await writeFile(join(repo, '.env'), 'SECRET=committed\n')
    git(['add', '.env'])
    git(['commit', '-m', 'track the env file'])
    git(['switch', initial])
    await writeFile(join(repo, '.gitignore'), '.env\n')
    git(['add', '.gitignore'])
    git(['commit', '-m', 'ignore the env file'])
    await writeFile(join(repo, '.env'), 'SECRET=local\n')
    assert.equal(git(['status', '--porcelain']), '', 'the clean check cannot see the ignored file')

    await assert.rejects(switchLocalBranch(repo, 'old-config'), (error: unknown) => {
      assert.ok(error instanceof GitSwitchRefusal)
      assert.match(error.message, /old-config would overwrite or delete these local files/)
      assert.match(error.message, /\n\.env$/)
      return true
    })
    assert.equal(git(['branch', '--show-current']), initial)
    assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'SECRET=local\n')
  })
})

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
    // Outside the repository, so the linked worktree is not an untracked change.
    const otherWorktree = await mkdtemp(join(tmpdir(), 'pi-branch-switch-other-'))
    try {
      git(['worktree', 'add', otherWorktree, 'target'])
      await assert.rejects(switchLocalBranch(repo, 'target'), /already (?:used|checked out)/)
      assert.equal(git(['branch', '--show-current']), initial)
    } finally {
      await rm(otherWorktree, { recursive: true, force: true })
    }
  })
})
