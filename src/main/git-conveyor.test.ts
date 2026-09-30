import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  ExpiringLookupCache,
  commandLabel,
  commitAll,
  countPorcelainFiles,
  countTrackedPorcelainFiles,
  createLocalBranch,
  createPullRequest,
  extractGitHubPullRequestUrl,
  extractUrl,
  getGitConveyorStatus,
  githubRepoFromRemote,
  parseAheadBehind,
  parseOpenPullRequest,
  pullRequestNumberFromUrl,
  pushBranch,
  readCommitDiff,
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

test('commit snapshots follow the curated index and exclude unstaged and untracked content', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'original\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    assert.equal(await readCommitDiff(repo), null)
    await writeFile(join(repo, 'app.ts'), 'staged version\n')
    const unstaged = await readCommitDiff(repo)
    git(['add', 'app.ts'])
    const staged = await readCommitDiff(repo)
    assert.equal(unstaged?.fingerprint, staged?.fingerprint)
    await writeFile(join(repo, 'app.ts'), 'later unstaged version\n')
    await writeFile(join(repo, 'untracked.txt'), 'not part of the commit\n')
    const selected = await readCommitDiff(repo)
    assert.equal(selected?.fingerprint, staged?.fingerprint)
    assert.match(selected!.diff, /\+staged version/)
    assert.doesNotMatch(selected!.diff, /later unstaged|not part of the commit/)
    assert.equal(git(['show', ':app.ts']), 'staged version')
  })
})

test('auto-stage snapshots accumulate tracked changes and change when content changes', async () => {
  await withGitRepo(async (repo, git) => {
    for (const name of ['a.txt', 'b.txt']) await writeFile(join(repo, name), 'original\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'a.txt'), 'first change\n')
    const first = await readCommitDiff(repo)
    await writeFile(join(repo, 'b.txt'), 'second change\n')
    const both = await readCommitDiff(repo)
    assert.notEqual(first?.fingerprint, both?.fingerprint)
    assert.match(both!.diff, /first change/)
    assert.match(both!.diff, /second change/)
    assert.equal(git(['diff', '--cached']), '')
  })
})

test('snapshots support staged first commits and detect binary content changes', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'image.bin'), Buffer.from([0, 1, 2]))
    assert.equal(await readCommitDiff(repo), null)
    git(['add', '.'])
    const first = await readCommitDiff(repo)
    assert.match(first!.diff, /GIT binary patch/)
    await writeFile(join(repo, 'image.bin'), Buffer.from([0, 1, 3]))
    git(['add', '.'])
    assert.notEqual((await readCommitDiff(repo))?.fingerprint, first?.fingerprint)
  })
})

test('snapshot scope matches commit scope in a monorepo and rejects an outside index', async () => {
  await withGitRepo(async (repo, git) => {
    const app = join(repo, 'app')
    await mkdir(app)
    await writeFile(join(app, 'a.txt'), 'original\n')
    await writeFile(join(repo, 'outside.txt'), 'original\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(app, 'a.txt'), 'inside\n')
    await writeFile(join(repo, 'outside.txt'), 'outside\n')
    const snapshot = await readCommitDiff(app)
    assert.match(snapshot!.diff, /\+inside/)
    assert.doesNotMatch(snapshot!.diff, /outside.txt/)
    git(['add', 'outside.txt'])
    await assert.rejects(readCommitDiff(app), /outside/i)
  })
})

test('non-repository folders have no commit snapshot', async () => {
  await withPlainFolder(async (folder) => assert.equal(await readCommitDiff(folder), null))
})

test('commitAll preserves a multiline subject and body longer than a single subject', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'new implementation\n')
    git(['add', 'app.ts'])
    const message = 'fix: preserve pending changes\n\n' + 'Explain the reviewed behavior and its verification. '.repeat(8)
    await commitAll(repo, { message })
    assert.equal(git(['log', '-1', '--pretty=%B']), message.trim())
  })
})

test('countPorcelainFiles counts changed porcelain rows, not changed lines', () => {
  assert.equal(countPorcelainFiles(' M src/a.ts\n?? src/new.ts\n'), 2)
  assert.equal(countPorcelainFiles(''), 0)
})

test('countTrackedPorcelainFiles leaves untracked rows out', () => {
  assert.equal(countTrackedPorcelainFiles('M src/a.ts\n?? src/new.ts\nD  gone.ts\nR  old.ts -> new.ts\n'), 3)
  assert.equal(countTrackedPorcelainFiles('?? src/new.ts\n'), 0)
  assert.equal(countTrackedPorcelainFiles(''), 0)
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

test('push ignores untracked files, which a commit never takes, and leaves them in place', async () => {
  await withGitRepo(async (repo, git) => {
    await withPlainFolder(async (remote) => {
      git(['init', '--bare'], remote)
      git(['remote', 'add', 'origin', remote])
      await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
      git(['add', 'app.ts'])
      git(['commit', '-m', 'initial'])
      await writeFile(join(repo, 'app.ts'), 'v1\n', 'utf8')
      await writeFile(join(repo, 'local.txt'), 'keep local\n', 'utf8')

      const committed = await commitAll(repo, { message: 'tracked change' })
      assert.equal(committed.dirtyFiles, 1)
      assert.equal(committed.dirtyTrackedFiles, 0)

      const pushed = await pushBranch(repo)
      assert.equal(git(['rev-parse', `refs/heads/${committed.branch}`], remote), committed.head)
      assert.equal(git(['ls-tree', '--name-only', committed.head], remote), 'app.ts')
      assert.equal(git(['status', '--porcelain']), '?? local.txt')
      assert.equal(await readFile(join(repo, 'local.txt'), 'utf8'), 'keep local\n')
      assert.equal(pushed.ahead, 0)
      assert.equal(pushed.hasUpstream, true)
    })
  })
})

test('push refuses staged and unstaged changes and honors the configured upstream', async () => {
  await withGitRepo(async (repo, git) => {
    await withPlainFolder(async (remote) => {
      git(['init', '--bare'], remote)
      git(['remote', 'add', 'fork', remote])
      await writeFile(join(repo, 'a.txt'), 'a0\n', 'utf8')
      await writeFile(join(repo, 'b.txt'), 'b0\n', 'utf8')
      git(['add', '.'])
      git(['commit', '-m', 'initial'])
      git(['push', '--set-upstream', 'fork', 'HEAD:published'])
      await writeFile(join(repo, 'a.txt'), 'a1\n', 'utf8')
      await writeFile(join(repo, 'b.txt'), 'b1\n', 'utf8')
      git(['add', 'a.txt'])
      const committed = await commitAll(repo, { message: 'staged only' })
      git(['add', 'b.txt'])
      await writeFile(join(repo, 'b.txt'), 'b2\n', 'utf8')
      const staged = git(['diff', '--cached'])
      const unstaged = git(['diff'])
      const published = git(['rev-parse', 'refs/heads/published'], remote)

      await assert.rejects(pushBranch(repo), /Commit the working tree before pushing/)
      assert.equal(git(['rev-parse', 'refs/heads/published'], remote), published)
      assert.equal(git(['diff', '--cached']), staged)
      assert.equal(git(['diff']), unstaged)
      assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'b2\n')

      git(['checkout', 'HEAD', '--', 'b.txt'])
      await pushBranch(repo)
      assert.equal(git(['rev-parse', 'refs/heads/published'], remote), committed.head)
      assert.equal(git(['show', 'published:a.txt'], remote), 'a1')
      assert.equal(git(['show', 'published:b.txt'], remote), 'b0')
    })
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
      dirtyTrackedFiles: 0,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      pushRemote: null,
      upstreamBranch: null,
      baseBranch: null,
      aheadOfBase: null,
      remoteUrl: null,
      pullRequestRepo: null,
      openPullRequest: null,
    })
  })
})

test('getGitConveyorStatus reports the origin URL and prefers the upstream remote HEAD as base branch', async () => {
  await withGitRepo(async (repo, git) => {
    await withPlainFolder(async (remote) => {
      git(['init', '--bare'], remote)
      git(['remote', 'add', 'origin', remote])
      await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
      git(['add', 'app.ts'])
      git(['commit', '-m', 'initial'])
      const base = git(['branch', '--show-current'])
      git(['push', '--set-upstream', 'origin', base])
      git(['remote', 'set-head', 'origin', base])
      git(['checkout', '-b', 'feature'])
      git(['push', '--set-upstream', 'origin', 'feature'])
      const status = await getGitConveyorStatus(repo)
      assert.equal(status.remoteUrl, remote)
      assert.equal(status.baseBranch, base)
      assert.equal(status.pullRequestRepo, null, 'a local bare remote is not a GitHub remote')
      git(['remote', 'set-url', 'origin', 'git@github.com:example/repo.git'])
      assert.equal((await getGitConveyorStatus(repo)).pullRequestRepo, 'example/repo')
      git(['remote', 'set-url', 'origin', remote])

      git(['remote', 'add', 'upstream', remote])
      git(['update-ref', 'refs/remotes/upstream/develop', 'HEAD'])
      git(['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/develop'])
      assert.equal((await getGitConveyorStatus(repo)).baseBranch, 'develop')
    })
  })
})

test('getGitConveyorStatus falls back to a conventional base branch and counts commits ahead of it', async () => {
  await withGitRepo(async (repo, git) => {
    await withPlainFolder(async (remote) => {
      git(['init', '--bare'], remote)
      git(['remote', 'add', 'origin', remote])
      git(['checkout', '-b', 'main'])
      await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
      git(['add', 'app.ts'])
      git(['commit', '-m', 'initial'])
      git(['push', '--set-upstream', 'origin', 'main'])

      const onBase = await getGitConveyorStatus(repo)
      assert.equal(onBase.baseBranch, 'main')
      assert.equal(onBase.aheadOfBase, 0)

      git(['checkout', '-b', 'feature'])
      git(['push', '--set-upstream', 'origin', 'feature'])
      assert.equal((await getGitConveyorStatus(repo)).aheadOfBase, 0)
      git(['commit', '--allow-empty', '-m', 'feature work'])
      assert.equal((await getGitConveyorStatus(repo)).aheadOfBase, 1)
    })
  })
})

test('getGitConveyorStatus reports no base without a remote-tracking base branch', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
    git(['add', 'app.ts'])
    git(['commit', '-m', 'initial'])
    const status = await getGitConveyorStatus(repo)
    assert.equal(status.baseBranch, null)
    assert.equal(status.aheadOfBase, null)
  })
})

test('createPullRequest refuses a blank title, uncommitted changes and unpushed work before running gh', async () => {
  await withGitRepo(async (repo, git) => {
    await withPlainFolder(async (remote) => {
      git(['init', '--bare'], remote)
      git(['remote', 'add', 'origin', remote])
      await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
      git(['add', 'app.ts'])
      git(['commit', '-m', 'initial'])
      const request = { title: 'Add feature', body: '' }

      await assert.rejects(createPullRequest(repo, { ...request, title: '  ' }), /Pull request title is required/)
      await assert.rejects(createPullRequest(repo, request), /Push the branch before creating a pull request/)
      git(['push', '--set-upstream', 'origin', 'HEAD'])
      await writeFile(join(repo, 'app.ts'), 'v1\n', 'utf8')
      await assert.rejects(createPullRequest(repo, request), /Commit the working tree before creating a pull request/)
      git(['commit', '-am', 'change'])
      await assert.rejects(createPullRequest(repo, request), /Push the branch before creating a pull request/)
      await writeFile(join(repo, 'untracked.txt'), 'never committed\n', 'utf8')
      await assert.rejects(createPullRequest(repo, request), /Push the branch before creating a pull request/)
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

test('a filtered commit records the selected tracked and staged paths and leaves untracked ones out', async () => {
  await withGitRepo(async (repo, git) => {
    for (const name of ['kept.ts', 'other.ts', 'gone.ts']) await writeFile(join(repo, name), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'kept.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'other.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'new.ts'), 'created\n', 'utf8')
    await writeFile(join(repo, 'added.ts'), 'staged by the user\n', 'utf8')
    await writeFile(join(repo, 'stray.ts'), 'not selected\n', 'utf8')
    await rm(join(repo, 'gone.ts'))
    git(['add', 'other.ts', 'added.ts'])

    const paths = ['kept.ts', 'new.ts', 'added.ts', 'gone.ts']
    const snapshot = await readCommitDiff(repo, paths)
    assert.match(snapshot!.diff, /\+v1/)
    assert.match(snapshot!.diff, /\+staged by the user/)
    assert.match(snapshot!.diff, /deleted file mode/)
    assert.doesNotMatch(snapshot!.diff, /new\.ts|created|other\.ts|stray\.ts/)
    assert.equal(await readCommitDiff(repo, ['new.ts']), null)

    await commitAll(repo, { message: 'selected files', paths })

    assert.deepEqual(git(['show', '--format=', '--name-status', 'HEAD']).split(/\r?\n/), ['A\tadded.ts', 'D\tgone.ts', 'M\tkept.ts'])
    assert.equal(git(['diff', '--cached', '--name-only']), 'other.ts')
    assert.match(git(['status', '--porcelain']), /^\?\? new\.ts$/m)
    assert.match(git(['status', '--porcelain']), /^\?\? stray\.ts$/m)
    assert.equal(await readCommitDiff(repo, ['kept.ts', 'new.ts']), null)
  })
})

test('a filtered commit of only untracked files commits nothing', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'app.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'new.ts'), 'created\n', 'utf8')

    await assert.rejects(() => commitAll(repo, { message: 'untracked only', paths: ['new.ts'] }), /No tracked changes/)
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
    assert.equal(git(['diff', '--cached', '--name-only']), '')
    assert.match(git(['status', '--porcelain']), /^\?\? new\.ts$/m)
  })
})

test('a filtered commit rejects paths outside the workspace before touching the index', async () => {
  await withGitRepo(async (repo, git) => {
    const app = join(repo, 'app')
    await mkdir(app)
    await writeFile(join(app, 'a.ts'), 'v0\n', 'utf8')
    await writeFile(join(repo, '.env'), 'SECRET=v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(app, 'a.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, '.env'), 'SECRET=v1\n', 'utf8')

    for (const paths of [['app/a.ts', '.env'], ['app/../.env'], [join(repo, '.env')], []]) {
      await assert.rejects(() => commitAll(app, { message: 'must not commit', paths }), /selected to commit|No files are selected/)
    }
    await commitAll(app, { message: 'inside only', paths: ['app/a.ts'] })
    assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'app/a.ts')
    assert.equal(git(['diff', '--cached', '--name-only']), '')
  })
})

test('a rejected filtered commit restores the index and leaves untracked files untracked', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'a.ts'), 'v0\n', 'utf8')
    await writeFile(join(repo, 'b.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'a.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'b.ts'), 'v1\n', 'utf8')
    git(['add', 'b.ts'])
    await writeFile(join(repo, 'new.ts'), 'created\n', 'utf8')
    await rejectCommits(repo, git)

    await assert.rejects(
      () => commitAll(repo, { message: 'blocked by the hook', paths: ['a.ts', 'new.ts'] }),
      /pre-commit hook rejected the commit/
    )
    assert.equal(git(['diff', '--cached', '--name-only']), 'b.ts')
    assert.equal(git(['diff', '--name-only']), 'a.ts')
    assert.match(git(['status', '--porcelain']), /^\?\? new\.ts$/m)
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
  })
})

test('a filtered commit can create the first commit of an unborn repository from staged files', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'first.ts'), 'hello\n', 'utf8')
    await writeFile(join(repo, 'later.ts'), 'later\n', 'utf8')
    git(['add', 'first.ts'])
    assert.match((await readCommitDiff(repo, ['first.ts', 'later.ts']))!.diff, /\+hello/)
    assert.doesNotMatch((await readCommitDiff(repo, ['first.ts', 'later.ts']))!.diff, /later/)
    await commitAll(repo, { message: 'first', paths: ['first.ts', 'later.ts'] })
    assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'first.ts')
    assert.match(git(['status', '--porcelain']), /^\?\? later\.ts$/m)
  })
})

test('a clone of an empty repository is not published until its first push, which sets the upstream', async () => {
  await withPlainFolder(async (base) => {
    const bare = join(base, 'remote.git')
    const clone = join(base, 'clone')
    const git = (args: string[], cwd = clone): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    git(['init', '--bare', bare], base)
    git(['clone', bare, clone], base)
    git(['config', 'user.email', 'pi-desktop@example.test'])
    git(['config', 'user.name', 'Pi Desktop Tests'])
    const branch = git(['branch', '--show-current'])
    assert.equal(git(['config', '--get', `branch.${branch}.merge`]), `refs/heads/${branch}`, 'the clone configures an upstream')

    const unborn = await getGitConveyorStatus(clone)
    assert.equal(unborn.head, '')
    assert.equal(unborn.hasUpstream, false)

    await writeFile(join(clone, 'README.md'), 'first\n', 'utf8')
    git(['add', 'README.md'])
    git(['commit', '-m', 'first'])
    const committed = await getGitConveyorStatus(clone)
    assert.equal(committed.hasUpstream, false, 'the remote-tracking branch does not exist yet')
    assert.equal(committed.ahead, 0)
    assert.equal(committed.upstreamBranch, branch)

    const pushed = await pushBranch(clone)
    assert.equal(pushed.hasUpstream, true)
    assert.equal(pushed.ahead, 0)
    assert.equal(git(['rev-parse', `refs/heads/${branch}`], bare), pushed.head)
    assert.equal(git(['rev-parse', '--abbrev-ref', '@{upstream}']), `origin/${branch}`)
  })
})

test('a branch whose remote branch was deleted is published again with its upstream', async () => {
  await withGitRepo(async (repo, git) => {
    await withPlainFolder(async (remote) => {
      git(['init', '--bare'], remote)
      git(['remote', 'add', 'origin', remote])
      git(['commit', '--allow-empty', '-m', 'initial'])
      git(['checkout', '-b', 'feature'])
      git(['push', '--set-upstream', 'origin', 'feature'])
      assert.equal((await getGitConveyorStatus(repo)).hasUpstream, true)
      git(['push', 'origin', '--delete', 'feature'])
      git(['fetch', '--prune', 'origin'])

      const gone = await getGitConveyorStatus(repo)
      assert.equal(gone.hasUpstream, false)
      assert.equal(gone.upstreamBranch, 'feature')
      await pushBranch(repo)
      assert.equal(git(['rev-parse', 'refs/heads/feature'], remote), git(['rev-parse', 'HEAD']))
      assert.equal((await getGitConveyorStatus(repo)).hasUpstream, true)
    })
  })
})

test('a filtered commit adds only the new files the user chose and leaves the others untracked', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'app.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'chosen.ts'), 'chosen\n', 'utf8')
    await writeFile(join(repo, 'left-out.ts'), 'left out\n', 'utf8')
    const paths = ['app.ts', 'chosen.ts', 'left-out.ts']

    const snapshot = await readCommitDiff(repo, paths, ['chosen.ts'])
    assert.match(snapshot!.diff, /\+chosen/)
    assert.doesNotMatch(snapshot!.diff, /left out/)
    assert.notEqual(snapshot!.fingerprint, (await readCommitDiff(repo, paths))!.fingerprint)

    await commitAll(repo, { message: 'with one new file', paths, newFiles: ['chosen.ts'] })
    assert.deepEqual(git(['show', '--format=', '--name-status', 'HEAD']).split(/\r?\n/), ['M\tapp.ts', 'A\tchosen.ts'])
    assert.equal(git(['status', '--porcelain']), '?? left-out.ts')
  })
})

test('the first commit of a cloned empty repository can hold only chosen new files', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8')
    await writeFile(join(repo, 'hello.js'), 'console.log(1)\n', 'utf8')
    const paths = ['README.md', 'hello.js']
    await assert.rejects(() => commitAll(repo, { message: 'nothing chosen', paths }), /No tracked changes/)
    await commitAll(repo, { message: 'first', paths, newFiles: paths })
    assert.deepEqual(git(['show', '--format=', '--name-only', 'HEAD']).split(/\r?\n/), paths)
    assert.equal(git(['status', '--porcelain']), '')
  })
})

test('a chosen new file must be a selected, untracked, not ignored file, never a directory', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, '.gitignore'), 'secret.env\n', 'utf8')
    await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'app.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'secret.env'), 'TOKEN=1\n', 'utf8')
    await mkdir(join(repo, 'dir'))
    await writeFile(join(repo, 'dir', 'inner.ts'), 'inner\n', 'utf8')
    await writeFile(join(repo, 'other.ts'), 'not selected\n', 'utf8')

    for (const [paths, newFiles] of [
      [['app.ts', 'secret.env'], ['secret.env']],
      [['app.ts', 'dir'], ['dir']],
      [['app.ts'], ['other.ts']],
    ]) {
      await assert.rejects(() => commitAll(repo, { message: 'refused', paths, newFiles }), /cannot be committed/)
    }
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
    assert.equal(git(['diff', '--cached', '--name-only']), '')
    assert.match(git(['status', '--porcelain', '--ignored']), /^!! secret\.env$/m)
  })
})

test('a rejected commit with chosen new files restores the index and keeps them untracked', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'a.ts'), 'v0\n', 'utf8')
    await writeFile(join(repo, 'b.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    await writeFile(join(repo, 'a.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'b.ts'), 'v1\n', 'utf8')
    git(['add', 'b.ts'])
    await writeFile(join(repo, 'new.ts'), 'created\n', 'utf8')
    await rejectCommits(repo, git)

    await assert.rejects(
      () => commitAll(repo, { message: 'blocked', paths: ['a.ts', 'new.ts'], newFiles: ['new.ts'] }),
      /pre-commit hook rejected the commit/,
    )
    assert.equal(git(['diff', '--cached', '--name-only']), 'b.ts')
    assert.match(git(['status', '--porcelain']), /^\?\? new\.ts$/m)
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
  })
})

test('createLocalBranch creates a valid new branch from HEAD and carries uncommitted changes', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'app.ts'), 'v0\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    const head = git(['rev-parse', 'HEAD'])
    const original = git(['branch', '--show-current'])
    await writeFile(join(repo, 'app.ts'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'new.ts'), 'new\n', 'utf8')

    for (const name of ['', 'bad..name', '-option', 'HEAD', 'with space', '@{-1}']) {
      await assert.rejects(() => createLocalBranch(repo, name), /not a valid branch name/)
    }
    await assert.rejects(() => createLocalBranch(repo, original), /already exists/)

    const status = await createLocalBranch(repo, 'feature/new-work')
    assert.equal(status.branch, 'feature/new-work')
    assert.equal(git(['rev-parse', 'HEAD']), head)
    assert.equal(await readFile(join(repo, 'app.ts'), 'utf8'), 'v1\n')
    assert.equal(git(['diff', '--name-only']), 'app.ts')
    assert.match(git(['status', '--porcelain']), /^\?\? new\.ts$/m)
  })
})

test('createLocalBranch refuses while a Git operation is in progress', async () => {
  await withGitRepo(async (repo, git) => {
    git(['commit', '--allow-empty', '-m', 'initial'])
    await writeFile(join(repo, '.git', 'MERGE_HEAD'), `${git(['rev-parse', 'HEAD'])}\n`, 'utf8')
    await assert.rejects(() => createLocalBranch(repo, 'feature'), /merge is in progress/)
  })
})

test('createPullRequest refuses a pushed branch whose remote has no base branch before running gh', async () => {
  await withGitRepo(async (repo, git) => {
    await withPlainFolder(async (remote) => {
      git(['init', '--bare'], remote)
      git(['remote', 'add', 'origin', remote])
      git(['checkout', '-b', 'feature'])
      git(['commit', '--allow-empty', '-m', 'feature work'])
      git(['push', '--set-upstream', 'origin', 'feature'])
      const status = await getGitConveyorStatus(repo)
      assert.equal(status.baseBranch, null)
      assert.equal(status.openPullRequest, null, 'a remote that is not on GitHub is never asked')
      await assert.rejects(createPullRequest(repo, { title: 'Feature', body: '' }), /no base branch/)
    })
  })
})

test('parseOpenPullRequest picks the open pull request whose head is on the head owner', () => {
  const rows = JSON.stringify([
    { number: 7, url: 'https://github.com/other/repo/pull/7', headRepositoryOwner: { login: 'someone-else' } },
    { number: 1, url: 'https://github.com/owner/repo/pull/1', headRepositoryOwner: { login: 'Owner' } },
  ])
  assert.deepEqual(parseOpenPullRequest(rows, 'owner'), { number: 1, url: 'https://github.com/owner/repo/pull/1' })
  assert.deepEqual(parseOpenPullRequest(rows, null), { number: 7, url: 'https://github.com/other/repo/pull/7' })
  assert.equal(parseOpenPullRequest('[]', 'owner'), null)
  assert.equal(parseOpenPullRequest('not json', 'owner'), null)
  assert.equal(parseOpenPullRequest('{"number":1}', 'owner'), null)
})

test('pullRequestNumberFromUrl reads the number of a GitHub pull request URL only', () => {
  assert.equal(pullRequestNumberFromUrl('https://github.com/PikkonMG/testapp/pull/12'), 12)
  assert.equal(pullRequestNumberFromUrl('https://github.com/PikkonMG/testapp/issues/12'), null)
})

test('gh errors name only the subcommand, never the title or body arguments', () => {
  assert.equal(commandLabel('gh', ['pr', 'create', '--title', 'T', '--body', '## Summary']), 'gh pr create')
  assert.equal(commandLabel('gh', ['pr']), 'gh pr')
})

test('ExpiringLookupCache shares a load, keeps its answer for the period, and loads again after it', async () => {
  let now = 0
  let loads = 0
  const cache = new ExpiringLookupCache<number | null>(1_000, () => now)
  const load = async (): Promise<number | null> => ++loads
  assert.deepEqual(await Promise.all([cache.get('branch', load), cache.get('branch', load)]), [1, 1])
  now = 999
  assert.equal(await cache.get('branch', load), 1)
  now = 1_000
  assert.equal(await cache.get('branch', load), 2)
  cache.set('branch', null)
  assert.equal(await cache.get('branch', load), null)
  cache.delete('branch')
  assert.equal(await cache.get('branch', load), 3)
})
