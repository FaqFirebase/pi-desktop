import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import {
  createGitAvailabilityCache,
  GIT_VERSION_ARGS,
  parseGitVersion,
  probeGitAvailability,
} from './git-availability'
import { GitCommandError, runGit } from './git-worktree'
import type { GitAvailability } from '../shared/ipc-contracts'

test('parseGitVersion reads every known version line', () => {
  assert.equal(parseGitVersion('git version 2.47.1\n'), '2.47.1')
  assert.equal(parseGitVersion('git version 2.43.0.windows.1\r\n'), '2.43.0.windows.1')
  assert.equal(parseGitVersion('git version 2.39.5 (Apple Git-154)\n'), '2.39.5')
  assert.equal(parseGitVersion('\ngit version 2.45.0\n'), '2.45.0')
  assert.equal(parseGitVersion('xcrun: error: invalid active developer path'), null)
  assert.equal(parseGitVersion(''), null)
})

test('probeGitAvailability reports the installed version', async () => {
  assert.deepEqual(
    await probeGitAvailability(async () => ({ stdout: 'git version 2.47.1\n', stderr: '' })),
    { status: 'found', version: '2.47.1' },
  )
})

test('probeGitAvailability reports a missing binary', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-git-availability-'))
  try {
    assert.deepEqual(
      await probeGitAvailability(() => runGit(GIT_VERSION_ARGS, folder, { PATH: folder })),
      { status: 'missing' },
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('probeGitAvailability reports a git that exits non-zero as failed', async () => {
  const stub = new GitCommandError(GIT_VERSION_ARGS, 1, '', 'xcrun: error: invalid active developer path\nmore\n')
  assert.deepEqual(
    await probeGitAvailability(async () => { throw stub }),
    { status: 'failed', detail: 'xcrun: error: invalid active developer path' },
  )
})

test('probeGitAvailability reports unknown output as failed', async () => {
  assert.deepEqual(
    await probeGitAvailability(async () => ({ stdout: 'hello\n', stderr: '' })),
    { status: 'failed', detail: 'hello' },
  )
})

test('probeGitAvailability finds the git on this machine', async () => {
  const result = await probeGitAvailability()
  assert.equal(result.status, 'found')
  assert.match((result as { version: string }).version, /^\d+\.\d+/)
})

test('get runs the probe once and shares its result', async () => {
  let runs = 0
  const cache = createGitAvailabilityCache(async () => { runs += 1; return { status: 'missing' } })
  const [first, second] = await Promise.all([cache.get(), cache.get()])
  assert.deepEqual(first, { status: 'missing' })
  assert.equal(second, first)
  assert.equal(runs, 1)
})

test('recheck replaces the cached result and get returns the newest one', async () => {
  const results: GitAvailability[] = [{ status: 'missing' }, { status: 'found', version: '2.47.1' }]
  const cache = createGitAvailabilityCache(async () => results.shift()!)
  assert.deepEqual(await cache.get(), { status: 'missing' })
  const rechecked = cache.recheck()
  assert.deepEqual(await cache.get(), { status: 'found', version: '2.47.1' })
  assert.deepEqual(await rechecked, { status: 'found', version: '2.47.1' })
})
