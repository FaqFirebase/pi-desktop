import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCommitMessageSuggestion, commitMessageScope, openCommitMessageInput,
} from './commit-message-input'

const untouched = { message: '', edited: false }

test('reopening the dialog shows the last suggestion for the same workspace without waiting', () => {
  const last = { scope: commitMessageScope('ws-1', undefined, []), message: 'fix: current changes' }
  assert.deepEqual(openCommitMessageInput(last, commitMessageScope('ws-1', undefined, [])), { message: 'fix: current changes', edited: false })
  assert.deepEqual(openCommitMessageInput(last, commitMessageScope('ws-2', undefined, [])), untouched)
  assert.deepEqual(openCommitMessageInput(null, commitMessageScope('ws-1', undefined, [])), untouched)
})

test('a suggestion for all changes is not reused for a filtered selection, or for another selection', () => {
  const all = { scope: commitMessageScope('ws-1', undefined, []), message: 'feat: everything' }
  const filtered = { scope: commitMessageScope('ws-1', ['a.ts'], []), message: 'fix: a' }
  assert.deepEqual(openCommitMessageInput(all, commitMessageScope('ws-1', ['a.ts'], [])), untouched)
  assert.deepEqual(openCommitMessageInput(filtered, commitMessageScope('ws-1', undefined, [])), untouched)
  assert.deepEqual(openCommitMessageInput(filtered, commitMessageScope('ws-1', ['a.ts', 'b.ts'], [])), untouched)
  assert.deepEqual(openCommitMessageInput(filtered, commitMessageScope('ws-1', ['a.ts'], [])), { message: 'fix: a', edited: false })
})

test('a suggestion fills a field the user has not typed in since clicking Suggest', () => {
  assert.deepEqual(applyCommitMessageSuggestion(untouched, 'fix: current changes'), {
    message: 'fix: current changes', edited: false,
  })
  assert.deepEqual(applyCommitMessageSuggestion({ message: 'fix: older suggestion', edited: false }, 'fix: new suggestion'), {
    message: 'fix: new suggestion', edited: false,
  })
})

test('text typed while a suggestion runs is never overwritten, including a cleared field', () => {
  for (const message of ['my own subject', 'fix: subject\n\nDetailed body\nSecond line', '']) {
    const edited = { message, edited: true }
    assert.equal(applyCommitMessageSuggestion(edited, 'fix: current changes'), edited)
  }
})

test('a missing suggestion leaves the input alone', () => {
  const edited = { message: 'mine', edited: true }
  assert.equal(applyCommitMessageSuggestion(edited, null), edited)
  assert.equal(applyCommitMessageSuggestion(untouched, null), untouched)
})

test('a suggestion describes the chosen new files too: another choice is another selection', () => {
  const withNewFile = { scope: commitMessageScope('ws-1', ['a.ts', 'new.ts'], ['new.ts']), message: 'feat: add new' }
  assert.deepEqual(openCommitMessageInput(withNewFile, commitMessageScope('ws-1', ['a.ts', 'new.ts'], [])), untouched)
  assert.deepEqual(openCommitMessageInput(withNewFile, commitMessageScope('ws-1', ['a.ts', 'new.ts'], ['new.ts'])), {
    message: 'feat: add new', edited: false,
  })
})
