import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GIT_DOWNLOAD_URL, shouldShowGitBanner } from './git-availability'

test('shouldShowGitBanner shows only an undismissed missing or failed git', () => {
  assert.equal(shouldShowGitBanner(null, false), false)
  assert.equal(shouldShowGitBanner({ status: 'found', version: '2.47.1' }, false), false)
  assert.equal(shouldShowGitBanner({ status: 'missing' }, false), true)
  assert.equal(shouldShowGitBanner({ status: 'failed', detail: 'x' }, false), true)
  assert.equal(shouldShowGitBanner({ status: 'missing' }, true), false)
})

test('GIT_DOWNLOAD_URL is the https download page', () => {
  assert.equal(GIT_DOWNLOAD_URL, 'https://git-scm.com/downloads')
})
