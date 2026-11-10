import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_RECALLED_PROMPT, composerDraftText, consumeSubmittedDraft, type SubmittedComposerDraft } from './composer-draft'

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

const sentAttachment = { kind: 'text' as const, path: '/sent.txt', name: 'sent.txt', content: 'sent' }
const addedAttachment = { kind: 'text' as const, path: '/later.txt', name: 'later.txt', content: 'later' }
const submitted: SubmittedComposerDraft = {
  scopeKey: 'runtime:first',
  revision: 1,
  text: '  raw prompt  ',
  attachments: [sentAttachment],
}

test('an accepted submission consumes the unchanged captured draft', () => {
  assert.deepEqual(consumeSubmittedDraft(submitted, submitted), { text: '', attachments: [] })
})

test('text and attachments added during a send survive acceptance', () => {
  const current = {
    ...submitted,
    revision: 2,
    text: 'next prompt',
    attachments: [sentAttachment, addedAttachment],
  }
  assert.deepEqual(consumeSubmittedDraft(submitted, current), {
    text: 'next prompt',
    attachments: [addedAttachment],
  })
})

test('retyping identical text during a send preserves the new edit', () => {
  assert.equal(consumeSubmittedDraft(submitted, { ...submitted, revision: 3 }).text, submitted.text)
})

test('a late accepted send cannot consume another target even with identical text', () => {
  const otherTarget = { ...submitted, scopeKey: 'runtime:second' }
  assert.equal(consumeSubmittedDraft(submitted, otherTarget), otherTarget)
})
