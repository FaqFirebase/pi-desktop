import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCommitMessageSuggestion, commitMessageScope, openCommitMessageInput, switchCommitMessageInput,
} from './commit-message-input'

const untouched = { message: '', edited: false }

test('reopening the dialog shows the last suggestion for the same workspace without waiting', () => {
  const last = { scope: commitMessageScope('ws-1', undefined), message: 'fix: current changes' }
  assert.deepEqual(openCommitMessageInput(last, commitMessageScope('ws-1', undefined)), { message: 'fix: current changes', edited: false })
  assert.deepEqual(openCommitMessageInput(last, commitMessageScope('ws-2', undefined)), untouched)
  assert.deepEqual(openCommitMessageInput(null, commitMessageScope('ws-1', undefined)), untouched)
})

test('a suggestion for all changes is not reused for a filtered selection, or for another selection', () => {
  const all = { scope: commitMessageScope('ws-1', undefined), message: 'feat: everything' }
  const filtered = { scope: commitMessageScope('ws-1', ['a.ts']), message: 'fix: a' }
  assert.deepEqual(openCommitMessageInput(all, commitMessageScope('ws-1', ['a.ts'])), untouched)
  assert.deepEqual(openCommitMessageInput(filtered, commitMessageScope('ws-1', undefined)), untouched)
  assert.deepEqual(openCommitMessageInput(filtered, commitMessageScope('ws-1', ['a.ts', 'b.ts'])), untouched)
  assert.deepEqual(openCommitMessageInput(filtered, commitMessageScope('ws-1', ['a.ts'])), { message: 'fix: a', edited: false })
})

test('the opening suggestion fills an untouched dialog', () => {
  assert.deepEqual(applyCommitMessageSuggestion(untouched, 'fix: current changes', false), {
    message: 'fix: current changes', edited: false,
  })
})

test('the opening suggestion never overwrites manual edits, including an intentionally cleared field', () => {
  for (const message of ['my own subject', 'fix: subject\n\nDetailed body\nSecond line', '']) {
    const edited = { message, edited: true }
    assert.equal(applyCommitMessageSuggestion(edited, 'fix: current changes', false), edited)
  }
})

test('an explicit regenerate replaces edited text with the new suggestion', () => {
  assert.deepEqual(applyCommitMessageSuggestion({ message: 'mine', edited: true }, 'fix: regenerated', true), {
    message: 'fix: regenerated', edited: false,
  })
})

test('a missing suggestion leaves the input alone', () => {
  const edited = { message: 'mine', edited: true }
  assert.equal(applyCommitMessageSuggestion(edited, null, true), edited)
  assert.equal(applyCommitMessageSuggestion(untouched, null, false), untouched)
})

test('switching between session files and all changes keeps typed text and otherwise follows the new scope', () => {
  const all = commitMessageScope('project', undefined)
  const session = commitMessageScope('project', ['a.ts'])
  const last = { scope: all, message: 'Update everything' }
  assert.deepEqual(switchCommitMessageInput({ message: 'Session draft', edited: false }, last, all),
    { message: 'Update everything', edited: false })
  assert.deepEqual(switchCommitMessageInput({ message: 'Update everything', edited: false }, last, session),
    { message: '', edited: false })
  assert.deepEqual(switchCommitMessageInput({ message: 'Mine', edited: true }, last, all), { message: 'Mine', edited: true })
})
