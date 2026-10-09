import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LinkedShipResult } from '../../../shared/ipc-contracts'
import { failedRepoNames, mergeShipResults } from './linked-ship-results'

const FIRST: LinkedShipResult = {
  repos: [
    { name: 'lib', outcome: 'shipped', pullRequestUrl: 'https://github.com/o/lib/pull/1' },
    { name: 'docs', outcome: 'failed', failedStep: 'push', error: 'rejected', pullRequestUrl: null },
    { name: 'app', outcome: 'failed', failedStep: 'pullRequest', error: 'no gh', pullRequestUrl: null },
  ],
}

test('failedRepoNames lists only the failed repositories, in order', () => {
  assert.deepEqual(failedRepoNames(FIRST), ['docs', 'app'])
})

test('a retry replaces the rows it reports in place and adds new ones at the end', () => {
  const retry: LinkedShipResult = {
    repos: [
      { name: 'app', outcome: 'shipped', pullRequestUrl: 'https://github.com/o/app/pull/2' },
      { name: 'docs', outcome: 'shipped', pullRequestUrl: 'https://github.com/o/docs/pull/3' },
      { name: 'extra', outcome: 'failed', failedStep: 'link', error: 'gh', pullRequestUrl: 'https://github.com/o/extra/pull/4' },
    ],
  }
  const merged = mergeShipResults(FIRST, retry)
  assert.deepEqual(merged.repos.map((repo) => [repo.name, repo.outcome]), [
    ['lib', 'shipped'], ['docs', 'shipped'], ['app', 'shipped'], ['extra', 'failed'],
  ])
  assert.deepEqual(failedRepoNames(merged), ['extra'])
})
