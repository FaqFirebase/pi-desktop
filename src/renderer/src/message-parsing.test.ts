import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAgentMessage } from './message-parsing'

test('parses user image blocks into named attachments', () => {
  const parsed = parseAgentMessage({
    role: 'user',
    id: 'user-1',
    timestamp: 123,
    content: [
      { type: 'text', text: 'can you see the image?' },
      { type: 'image', mimeType: 'image/png', data: 'abc123' },
    ],
  })

  assert.equal(parsed?.role, 'user')
  assert.equal(parsed?.content, 'can you see the image?')
  assert.deepEqual(parsed?.attachments, [
    { kind: 'image', name: 'Image 1', mimeType: 'image/png', data: 'abc123' },
  ])
})

test('keeps a provided attachment name and numbers unnamed ones', () => {
  const parsed = parseAgentMessage({
    role: 'user',
    content: [
      { type: 'image', mimeType: 'image/png', data: 'a', name: 'shot.png' },
      { type: 'image', mimeType: 'image/jpeg', data: 'b' },
    ],
  })

  assert.deepEqual(parsed?.attachments, [
    { kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'a' },
    { kind: 'image', name: 'Image 2', mimeType: 'image/jpeg', data: 'b' },
  ])
})

test('user message without images has no attachments', () => {
  const parsed = parseAgentMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
  assert.equal(parsed?.attachments, undefined)
})

test('ignores image blocks missing mimeType or data', () => {
  const parsed = parseAgentMessage({
    role: 'user',
    content: [
      { type: 'image', mimeType: 'image/png' },
      { type: 'image', data: 'no-mime' },
    ],
  })
  assert.equal(parsed?.attachments, undefined)
})

test('parses assistant text, thinking, tool calls, and model metadata', () => {
  const parsed = parseAgentMessage({
    role: 'assistant',
    model: 'gpt-5.5',
    provider: 'openai-codex',
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'answer' },
      { type: 'toolCall', id: 't1', name: 'bash', arguments: { cmd: 'ls' } },
    ],
  })

  assert.equal(parsed?.role, 'assistant')
  assert.equal(parsed?.content, 'answer')
  assert.equal(parsed?.thinking, 'hmm')
  assert.equal(parsed?.model, 'gpt-5.5')
  assert.equal(parsed?.provider, 'openai-codex')
  assert.deepEqual(parsed?.toolCalls, [
    { id: 't1', name: 'bash', arguments: JSON.stringify({ cmd: 'ls' }) },
  ])
})

test('parses toolResult text content', () => {
  const parsed = parseAgentMessage({ role: 'toolResult', content: [{ type: 'text', text: 'output' }] })
  assert.equal(parsed?.role, 'toolResult')
  assert.equal(parsed?.content, 'output')
})

test('returns null for non-objects and unknown roles', () => {
  assert.equal(parseAgentMessage(null), null)
  assert.equal(parseAgentMessage('nope'), null)
  assert.equal(parseAgentMessage({ role: 'mystery' }), null)
})
