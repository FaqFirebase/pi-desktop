import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  commitAll,
  countPorcelainFiles,
  extractGitHubPullRequestUrl,
  extractUrl,
  getGitConveyorStatus,
  githubRepoFromRemote,
  parseAheadBehind,
} from './git-conveyor'

type GitRunner = (args: string[], cwd?: string) => string

const REJECTING_PRE_COMMIT_HOOK = '#!/bin/sh\necho "pre-commit hook rejected the commit" >&2\nexit 1\n'
const EXECUTABLE_FILE_MODE = 0o755

async function withGitRepo(fn: (repo: string, git: GitRunner) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'pi-git-conveyor-'))
  const git = (args: string[], cwd = repo): string => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`)
    return result.stdout.trim()
  }
  git(['init'])
  git(['config', 'user.email', 'pi-desktop@example.test'])
  git(['config', 'user.name', 'Pi Desktop Tests'])
  try {
    await fn(repo, git)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

async function withPlainFolder(fn: (folder: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'pi-git-plain-'))
  try {
    await fn(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** Make every commit in `repo` fail the way a rejecting pre-commit hook does. */
async function rejectCommits(repo: string, git: GitRunner): Promise<void> {
  const hooks = join(repo, '.git', 'hooks')
  await mkdir(hooks, { recursive: true })
  await writeFile(join(hooks, 'pre-commit'), REJECTING_PRE_COMMIT_HOOK, {
    encoding: 'utf8',
    mode: EXECUTABLE_FILE_MODE,
  })
  // Pin the path so a global core.hooksPath cannot disable the hook.
  git(['config', 'core.hooksPath', hooks])
}

test('countPorcelainFiles counts changed porcelain rows, not changed lines', () => {
  assert.equal(countPorcelainFiles(' M src/a.ts\n?? src/new.ts\n'), 2)
  assert.equal(countPorcelainFiles(''), 0)
})

test('parseAheadBehind handles upstream counts and missing upstreams', () => {
  assert.deepEqual(parseAheadBehind('2\t5\n'), { behind: 2, ahead: 5 })
  assert.deepEqual(parseAheadBehind(null), { behind: 0, ahead: 0 })
})

test('extractUrl returns the first CLI URL without inventing one', () => {
  assert.equal(extractUrl('Created pull request: https://github.com/example/repo/pull/42'), 'https://github.com/example/repo/pull/42')
  assert.equal(extractUrl('authentication required'), null)
})

test('extractGitHubPullRequestUrl finds a PR URL inside a task', () => {
  assert.equal(
    extractGitHubPullRequestUrl('Continue https://github.com/FaqFirebase/pi-desktop/pull/55.'),
    'https://github.com/FaqFirebase/pi-desktop/pull/55'
  )
  assert.equal(extractGitHubPullRequestUrl('Fix issue #55'), null)
})

test('githubRepoFromRemote normalizes HTTPS and SSH remotes', () => {
  assert.equal(githubRepoFromRemote('https://github.com/FaqFirebase/pi-desktop.git'), 'FaqFirebase/pi-desktop')
  assert.equal(githubRepoFromRemote('git@github.com:FaqFirebase/pi-desktop.git'), 'FaqFirebase/pi-desktop')
  assert.equal(githubRepoFromRemote('https://gitlab.com/example/repo.git'), null)
})

test('commitAll creates the first commit in an unborn repository from the staged index', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'README.md'), 'first commit\n', 'utf8')
    git(['add', 'README.md'])
    const status = await commitAll(repo, { message: 'initial commit' })
    assert.equal(status.lastCommitMessage, 'initial commit')
    assert.notEqual(status.head, '')
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
  })
})

test('commitAll keeps untracked files out of an auto-staged commit', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'app.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, '.env'), 'SECRET=not-for-commit\n', 'utf8')

    await commitAll(repo, { message: 'tracked change' })

    assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'app.ts')
    assert.match(git(['status', '--porcelain']), /^\?\? \.env$/m)
  })
})

test('commitAll refuses to commit when only untracked files changed', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'key.pem'), 'private key\n', 'utf8')

    await assert.rejects(
      () => commitAll(repo, { message: 'must not sweep' }),
      /No tracked changes to commit/
    )
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
    assert.equal(git(['status', '--porcelain']), '?? key.pem')
  })
})

test('commitAll refuses an unborn repository that has nothing staged', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'README.md'), 'first commit\n', 'utf8')

    await assert.rejects(
      () => commitAll(repo, { message: 'initial commit' }),
      /No tracked changes to commit/
    )
    assert.equal(git(['status', '--porcelain']), '?? README.md')
  })
})

test('commitAll restores the auto-staged index when the commit fails', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'a.txt'), 'a0\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'b0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'a.txt'), 'a1\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'b1\n', 'utf8')
    await rejectCommits(repo, git)

    await assert.rejects(
      () => commitAll(repo, { message: 'blocked by the hook' }),
      /pre-commit hook rejected the commit/
    )
    assert.equal(git(['diff', '--cached', '--name-only']), '')
    assert.equal(git(['diff', '--name-only']), 'a.txt\nb.txt')
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
  })
})

test('commitAll leaves a curated index intact when the commit fails', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'a.txt'), 'a0\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'b0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'a.txt'), 'a1\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'b1\n', 'utf8')
    git(['add', 'a.txt'])
    await rejectCommits(repo, git)

    await assert.rejects(
      () => commitAll(repo, { message: 'blocked by the hook' }),
      /pre-commit hook rejected the commit/
    )
    assert.equal(git(['diff', '--cached', '--name-only']), 'a.txt')
    assert.equal(git(['diff', '--name-only']), 'b.txt')
  })
})

test('commitAll refuses an index that stages files outside the workspace', async () => {
  await withGitRepo(async (repo, git) => {
    const app = join(repo, 'app')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'index.ts'), 'v0\n', 'utf8')
    await writeFile(join(repo, '.env'), 'SECRET=not-for-commit\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, '.env'), 'SECRET=still-local\n', 'utf8')
    await writeFile(join(app, 'index.ts'), 'v1\n', 'utf8')
    git(['add', '.env'])

    await assert.rejects(
      () => commitAll(app, { message: 'must not commit' }),
      /staged files outside the active workspace/
    )
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
    assert.equal(git(['diff', '--cached', '--name-only']), '.env')
  })
})

test('commitAll commits a staged index reached through a symlinked workspace', async (t) => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'app.ts'), 'v1\n', 'utf8')
    git(['add', 'app.ts'])
    const link = `${repo}-link`
    try {
      await symlink(repo, link, 'dir')
    } catch (error) {
      // Windows needs elevation for symlinks; the guard itself stays POSIX-tested.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      t.skip('creating a symlink requires elevation on this platform')
      return
    }
    try {
      // Git reports the resolved worktree root, so an unresolved workspace path
      // must not make every staged file look like it sits outside the workspace.
      await commitAll(link, { message: 'through the symlink' })
      assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'app.ts')
    } finally {
      await rm(link, { force: true })
    }
  })
})

test('getGitConveyorStatus reports an idle state for a folder outside any repository', async () => {
  await withPlainFolder(async (folder) => {
    assert.deepEqual(await getGitConveyorStatus(folder), {
      branch: null,
      head: '',
      lastCommitMessage: null,
      dirtyFiles: 0,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      pushRemote: null,
      upstreamBranch: null,
      baseBranch: null,
      remoteUrl: null,
    })
  })
})

test('getGitConveyorStatus still reports failures other than a missing repository', async () => {
  const missing = await mkdtemp(join(tmpdir(), 'pi-git-plain-'))
  await rm(missing, { recursive: true, force: true })
  await assert.rejects(() => getGitConveyorStatus(missing), /ENOENT/)
})

test('commitAll rejects Git operation states before staging', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'README.md'), 'initial\n', 'utf8')
    git(['add', 'README.md'])
    await commitAll(repo, { message: 'initial commit' })
    await writeFile(join(repo, 'README.md'), 'conflicted\n', 'utf8')
    await writeFile(join(repo, '.git', 'MERGE_HEAD'), git(['rev-parse', 'HEAD']) + '\n', 'utf8')
    await assert.rejects(
      () => commitAll(repo, { message: 'must not commit' }),
      /Git merge is in progress/
    )
  })
})

test('commitAll scopes auto-staging to the active monorepo directory', async () => {
  await withGitRepo(async (repo, git) => {
    const app = join(repo, 'packages', 'app')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'index.ts'), 'before\n', 'utf8')
    await writeFile(join(repo, '.env'), 'SECRET=not-for-commit\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(app, 'index.ts'), 'after\n', 'utf8')
    await writeFile(join(repo, '.env'), 'SECRET=still-local\n', 'utf8')

    await commitAll(app, { message: 'scoped change' })

    const names = git(['show', '--format=', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean)
    assert.deepEqual(names, ['packages/app/index.ts'])
    assert.match(git(['status', '--porcelain']), /M \.env$/m)
  })
})

test('commitAll preserves a curated index inside the workspace', async () => {
  await withGitRepo(async (repo, git) => {
    const app = join(repo, 'app')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'a.txt'), 'a0\n', 'utf8')
    await writeFile(join(app, 'b.txt'), 'b0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(app, 'a.txt'), 'a1\n', 'utf8')
    await writeFile(join(app, 'b.txt'), 'b1\n', 'utf8')
    git(['add', 'app/a.txt'])

    await commitAll(app, { message: 'staged only' })

    assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'app/a.txt')
    assert.match(git(['status', '--porcelain']), /M app\/b\.txt$/m)
  })
})
