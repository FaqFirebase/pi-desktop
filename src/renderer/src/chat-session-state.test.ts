import { test } from 'node:test'
import assert from 'node:assert/strict'
import { t } from '../../shared/i18n'
import { chatEventNotice, keepNoticesInPlace, type ChatMessage } from './chat-session-state'

const PROVIDER_ERROR = '403 subscription required'

function chat(id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return { id, role, content: id, timestamp: 0 }
}

test('a failed assistant turn gives one error notice; other messages give none', () => {
  const failed = { role: 'assistant', stopReason: 'error', errorMessage: PROVIDER_ERROR, content: [] }
  assert.equal(chatEventNotice({ type: 'message_end', message: failed }), t('store.messages.error', { detail: PROVIDER_ERROR }))
  assert.equal(chatEventNotice({ type: 'message_end', message: { ...failed, role: 'user' } }), null)
  assert.equal(chatEventNotice({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } }), null)
  assert.equal(chatEventNotice({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Request was aborted' } }), null, 'a plain user stop is not an error')
  assert.equal(chatEventNotice({ type: 'turn_end', message: failed, toolResults: [] }), null, 'turn_end re-delivers the message, so it adds nothing')
})

test('compaction, retry and command output use the shared notice wording', () => {
  assert.equal(chatEventNotice({ type: 'compaction_start', reason: 'threshold' }), t('store.messages.compactingContext', { reason: 'threshold' }))
  assert.equal(chatEventNotice({ type: 'compaction_end', reason: 'threshold', result: {}, aborted: false, willRetry: false }), t('store.messages.contextCompacted'))
  assert.equal(chatEventNotice({ type: 'compaction_end', reason: 'threshold', result: null, aborted: true, willRetry: false }), t('store.messages.compactionAborted'))
  assert.equal(chatEventNotice({ type: 'compaction_end', reason: 'threshold', result: null, aborted: false, willRetry: false }), null)
  assert.equal(
    chatEventNotice({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: PROVIDER_ERROR }),
    t('store.messages.retrying', { attempt: 1, maxAttempts: 3, detail: PROVIDER_ERROR }),
  )
  assert.equal(chatEventNotice({ type: 'command_output', text: '\u001b[32mdone\u001b[0m' }), 'done')
  assert.equal(chatEventNotice({ type: 'command_output', text: '  ' }), null)
})

test('a reload keeps each local notice after the same number of messages it followed', () => {
  const isNotice = (message: ChatMessage): boolean => message.id.startsWith('notice-')
  const previous = [chat('u1', 'user'), chat('a1'), chat('notice-1', 'system'), chat('u2', 'user'), chat('notice-2', 'system')]
  // The engine history carries its own ids, and the merge appends local notices last.
  const merged = [chat('h-u1', 'user'), chat('h-a1'), chat('h-u2', 'user'), chat('h-a2'), chat('notice-1', 'system'), chat('notice-2', 'system')]
  assert.deepEqual(keepNoticesInPlace(merged, previous, isNotice).map((message) => message.id), ['h-u1', 'h-a1', 'notice-1', 'h-u2', 'notice-2', 'h-a2'])
  const plain = [chat('h-u1', 'user')]
  assert.equal(keepNoticesInPlace(plain, previous, isNotice), plain, 'no notice means no copy')
})
