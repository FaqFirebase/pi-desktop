import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PiMessageUpdateEvent, PiRpcEvent } from '../shared/ipc-contracts'
import { StreamingTextTracker } from './streaming-text-tracker'

function delta(type: string, text: string): PiMessageUpdateEvent {
  return { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type, delta: text } }
}

test('stamps each text and thinking delta with its offset and keeps the text so far', () => {
  const tracker = new StreamingTextTracker()
  const events = [delta('thinking_delta', 'Plan.'), delta('text_delta', 'Hello'), delta('text_delta', ' world')]
  for (const event of events) tracker.observe(event)
  assert.deepEqual(events.map((event) => event.assistantMessageEvent.offset), [0, 0, 5])
  assert.deepEqual(tracker.snapshot(), { content: 'Hello world', thinking: 'Plan.' })
})

test('starts over at each assistant message and at the end of a run', () => {
  const tracker = new StreamingTextTracker()
  const boundaries: PiRpcEvent[] = [
    { type: 'message_start', message: { role: 'assistant' } } as PiRpcEvent,
    { type: 'message_end', message: { role: 'assistant' } } as PiRpcEvent,
    { type: 'agent_end', messages: [] } as PiRpcEvent,
  ]
  for (const boundary of boundaries) {
    tracker.observe(delta('text_delta', 'old'))
    tracker.observe(boundary)
    assert.deepEqual(tracker.snapshot(), { content: '', thinking: '' })
  }
  const next = delta('text_delta', 'new')
  tracker.observe(next)
  assert.equal(next.assistantMessageEvent.offset, 0)
})

test('leaves other updates and a user message start alone', () => {
  const tracker = new StreamingTextTracker()
  tracker.observe(delta('text_delta', 'kept'))
  const toolDelta = delta('toolcall_delta', '{"path":')
  tracker.observe(toolDelta)
  tracker.observe({ type: 'message_start', message: { role: 'user' } } as PiRpcEvent)
  assert.equal(toolDelta.assistantMessageEvent.offset, undefined)
  assert.deepEqual(tracker.snapshot(), { content: 'kept', thinking: '' })
})
