import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { watchGitHead } from './git-head-watcher'

/** Upper bound for a HEAD change to be reported: the debounce plus watcher start-up. */
const REPORT_WITHIN_MS = 2_000
/** Time the watcher needs to resolve the git directory and start. */
const WATCH_START_MS = 500

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRepo(fn: (repo: string, git: (args: string[]) => void) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'pi-git-head-'))
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  git(['init'])
  git(['config', 'user.email', 'pi-desktop@example.test'])
  git(['config', 'user.name', 'Pi Desktop Tests'])
  git(['commit', '--allow-empty', '-m', 'initial'])
  try {
    await fn(repo, git)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

test('a branch created and switched to outside the app is reported once, within two seconds', async () => {
  await withRepo(async (repo, git) => {
    let changes = 0
    const stop = watchGitHead(repo, () => { changes++ })
    try {
      await wait(WATCH_START_MS)
      const started = Date.now()
      git(['switch', '-c', 'feature/terminal'])
      while (changes === 0 && Date.now() - started < REPORT_WITHIN_MS) await wait(50)
      assert.equal(changes, 1)
    } finally {
      stop()
    }
  })
})

test('a branch created or deleted outside the app without a checkout is reported', async () => {
  await withRepo(async (repo, git) => {
    let changes = 0
    const stop = watchGitHead(repo, () => { changes++ })
    try {
      await wait(WATCH_START_MS)
      for (const args of [['branch', 'feature/no-checkout'], ['branch', '-d', 'feature/no-checkout']]) {
        const before = changes
        const started = Date.now()
        git(args)
        while (changes === before && Date.now() - started < REPORT_WITHIN_MS) await wait(50)
        assert.equal(changes, before + 1, args.join(' '))
      }
    } finally {
      stop()
    }
  })
})

test('a stopped watch reports nothing, and a folder outside any repository is not watched', async () => {
  await withRepo(async (repo, git) => {
    let changes = 0
    const stop = watchGitHead(repo, () => { changes++ })
    await wait(WATCH_START_MS)
    stop()
    git(['switch', '-c', 'after-stop'])
    await wait(REPORT_WITHIN_MS / 2)
    assert.equal(changes, 0)
  })
  const plain = await mkdtemp(join(tmpdir(), 'pi-git-head-plain-'))
  try {
    const stop = watchGitHead(plain, () => assert.fail('nothing to watch'))
    await wait(WATCH_START_MS)
    stop()
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
})
