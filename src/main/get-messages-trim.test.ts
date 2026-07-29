import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_CONTENT_CHARS,
  MAX_MESSAGES_FOR_UI,
  trimGetMessagesResponse,
  trimMessagePayload,
} from './get-messages-trim'

test('trimGetMessagesResponse keeps the last MAX_MESSAGES_FOR_UI turns', () => {
  const messages = Array.from({ length: MAX_MESSAGES_FOR_UI + 20 }, (_, i) => ({
    role: 'user',
    content: `msg-${i}`,
  }))
  const out = trimGetMessagesResponse({
    success: true,
    data: { messages, other: 1 },
  }) as {
    data: { messages: unknown[]; truncatedFromStart: boolean; totalMessageCount: number; other: number }
  }

  assert.equal(out.data.messages.length, MAX_MESSAGES_FOR_UI)
  assert.equal(out.data.truncatedFromStart, true)
  assert.equal(out.data.totalMessageCount, MAX_MESSAGES_FOR_UI + 20)
  assert.equal(out.data.other, 1)
  assert.deepEqual(out.data.messages[0], { role: 'user', content: 'msg-20' })
  assert.deepEqual(out.data.messages[out.data.messages.length - 1], {
    role: 'user',
    content: `msg-${MAX_MESSAGES_FOR_UI + 19}`,
  })
})

test('trimGetMessagesResponse leaves short histories intact', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  const out = trimGetMessagesResponse({ success: true, data: { messages } }) as {
    data: { messages: unknown[]; truncatedFromStart: boolean; totalMessageCount: number }
  }
  assert.equal(out.data.messages.length, 1)
  assert.equal(out.data.truncatedFromStart, false)
  assert.equal(out.data.totalMessageCount, 1)
})

test('trimMessagePayload caps long string content', () => {
  const long = 'x'.repeat(MAX_CONTENT_CHARS + 500)
  const out = trimMessagePayload({ role: 'assistant', content: long }) as {
    content: string
  }
  assert.ok(out.content.length < long.length)
  assert.ok(out.content.includes('truncated'))
})

test('trimMessagePayload caps content block text and tool results', () => {
  const long = 'y'.repeat(MAX_CONTENT_CHARS + 5_000)
  const out = trimMessagePayload({
    role: 'assistant',
    content: [{ type: 'text', text: long }],
    toolCalls: [{ arguments: long, result: long }],
    result: long,
    thinking: long,
  }) as {
    content: Array<{ text: string }>
    toolCalls: Array<{ arguments: string; result: string }>
    result: string
    thinking: string
  }
  assert.ok(out.content[0].text.length < long.length)
  assert.ok(out.toolCalls[0].arguments.length <= MAX_CONTENT_CHARS + 1)
  assert.ok(out.toolCalls[0].result.includes('truncated'))
  assert.ok(out.result.includes('truncated'))
  assert.ok(out.thinking.endsWith('…'))
})

test('trimGetMessagesResponse is a no-op for non-message shapes', () => {
  assert.equal(trimGetMessagesResponse(null), null)
  assert.equal(trimGetMessagesResponse('x'), 'x')
  assert.deepEqual(trimGetMessagesResponse({ success: true }), { success: true })
})
