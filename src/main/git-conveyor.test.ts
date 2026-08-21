import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  commitAll,
  countPorcelainFiles,
  extractGitHubPullRequestUrl,
  extractUrl,
  githubRepoFromRemote,
  parseAheadBehind,
} from './git-conveyor'
async function withGitRepo(fn: (repo: string, git: (args: string[], cwd?: string) => string) => Promise<void>): Promise<void> {
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

test('commitAll creates the first commit in an unborn repository', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'README.md'), 'first commit\n', 'utf8')
    const status = await commitAll(repo, { message: 'initial commit' })
    assert.equal(status.lastCommitMessage, 'initial commit')
    assert.notEqual(status.head, '')
    assert.equal(git(['rev-list', '--count', 'HEAD']), '1')
  })
})

test('commitAll rejects Git operation states before staging', async () => {
  await withGitRepo(async (repo, git) => {
    await writeFile(join(repo, 'README.md'), 'initial\n', 'utf8')
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
