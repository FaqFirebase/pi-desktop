import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countPorcelainFiles, extractGitHubPullRequestUrl, extractUrl, githubRepoFromRemote, parseAheadBehind } from './git-conveyor'

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
