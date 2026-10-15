import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_RECALLED_PROMPT, composerDraftText } from './composer-draft'

const RECALLED_PROMPT_INDEX = 0

test('without history recall the draft is the textarea text', () => {
  assert.equal(composerDraftText('typed text', NO_RECALLED_PROMPT, ''), 'typed text')
})

test('during history recall the draft is the stashed text, not the recalled prompt', () => {
  assert.equal(composerDraftText('recalled prompt', RECALLED_PROMPT_INDEX, 'typed text'), 'typed text')
})

test('recall started from an empty composer saves no draft', () => {
  assert.equal(composerDraftText('recalled prompt', RECALLED_PROMPT_INDEX, ''), '')
})
