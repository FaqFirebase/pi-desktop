import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DisplayMessage } from './message-parsing'
import { markUnansweredToolCallsRunning, settleRunningToolCall } from './reattached-tool-calls'

const history: DisplayMessage[] = [
  { id: 'u0', role: 'user', content: 'earlier', timestamp: 0 },
  { id: 'a0', role: 'assistant', content: '', timestamp: 0, toolCalls: [{ id: 'old', name: 'bash', arguments: '{}' }] },
  { id: 'u1', role: 'user', content: 'now', timestamp: 0 },
  {
    id: 'a1', role: 'assistant', content: '', timestamp: 0,
    toolCalls: [{ id: 'done', name: 'bash', arguments: '{}' }, { id: 'live', name: 'bash', arguments: '{}' }],
  },
  { id: 'r1', role: 'toolResult', content: 'ok', timestamp: 0, toolCallId: 'done' },
]

test('a call of the current turn without a result shows as running after a mid-turn return', () => {
  const marked = markUnansweredToolCallsRunning(history)
  assert.deepEqual(marked[3].toolCalls?.map((call) => [call.id, call.isExecuting]), [['done', undefined], ['live', true]])
  assert.equal(marked[1], history[1], 'an older unanswered call is history, not a running tool')
  const answeredOnly = history.slice(0, 1)
  assert.equal(markUnansweredToolCallsRunning(answeredOnly), answeredOnly)
})

test('the finished tool shows its outcome and nothing else changes', () => {
  const marked = markUnansweredToolCallsRunning(history)
  const settled = settleRunningToolCall(marked, 'live', false)
  assert.deepEqual(settled[3].toolCalls?.[1], { id: 'live', name: 'bash', arguments: '{}', isExecuting: false, isError: false })
  assert.equal(settleRunningToolCall(settled, 'unknown', true), settled)
})
