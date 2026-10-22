import { test } from 'node:test'
import assert from 'node:assert/strict'

import { relayEventsToDisplayMessages } from './relay-transcript'

test('user_input and agent_message become one bubble each, in wire order', () => {
  const messages = relayEventsToDisplayMessages([
    { type: 'user_input', ts: 1000, id: 'u1', text: 'hello' },
    { type: 'agent_message', ts: 2000, text: 'hi there' },
  ])
  assert.equal(messages.length, 2)
  assert.deepEqual(
    messages.map((message) => [message.role, message.content]),
    [
      ['user', 'hello'],
      ['assistant', 'hi there'],
    ],
  )
})

test('a tool result attaches to the call it answers instead of adding a bubble', () => {
  // The local UI renders a call with its output attached, so a remote transcript
  // that showed two bubbles would look different for the same conversation.
  const messages = relayEventsToDisplayMessages([
    { type: 'tool_request', ts: 1000, tool_call_id: 'c1', tool: 'read', args: { path: 'a.ts' } },
    { type: 'tool_result', ts: 2000, tool_call_id: 'c1', result: 'file contents' },
  ])
  assert.equal(messages.length, 1)
  const call = messages[0].toolCalls?.[0]
  assert.equal(call?.name, 'read')
  assert.equal(call?.result, 'file contents')
  assert.equal(call?.isExecuting, false)
})

test('a result whose call is outside the window still renders rather than vanishing', () => {
  // Pi truncates history, so a result can arrive with no matching call.
  const messages = relayEventsToDisplayMessages([
    { type: 'tool_result', ts: 2000, tool_call_id: 'gone', tool: 'bash', result: 'output' },
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'toolResult')
  assert.equal(messages[0].content, 'output')
})

test('an errored tool result is marked as an error', () => {
  const messages = relayEventsToDisplayMessages([
    { type: 'tool_request', ts: 1000, tool_call_id: 'c1', tool: 'bash', args: {} },
    { type: 'tool_result', ts: 2000, tool_call_id: 'c1', result: 'boom', is_error: true },
  ])
  assert.equal(messages[0].toolCalls?.[0].isError, true)
})

test('non-string results keep their structure instead of becoming [object Object]', () => {
  const messages = relayEventsToDisplayMessages([
    { type: 'tool_request', ts: 1000, tool_call_id: 'c1', tool: 'api', args: {} },
    { type: 'tool_result', ts: 2000, tool_call_id: 'c1', result: { ok: true, n: 2 } },
  ])
  const result = messages[0].toolCalls?.[0].result ?? ''
  assert.match(result, /"ok": true/)
  assert.doesNotMatch(result, /object Object/)
})

test('unknown event kinds are skipped rather than rendered as empty bubbles', () => {
  const messages = relayEventsToDisplayMessages([
    { type: 'compaction', ts: 1000 },
    { type: 'usage', ts: 1500 },
    { type: 'agent_message', ts: 2000, text: 'still here' },
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'still here')
})

test('empty text produces no bubble', () => {
  const messages = relayEventsToDisplayMessages([
    { type: 'user_input', ts: 1000, text: '' },
    { type: 'agent_message', ts: 2000, text: '' },
  ])
  assert.equal(messages.length, 0)
})
