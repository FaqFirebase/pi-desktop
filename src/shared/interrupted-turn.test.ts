import { test } from 'node:test'
import assert from 'node:assert/strict'

import { continuationPrompt, interruptionReason, tailMessagesFrom, type SessionTailMessage } from './interrupted-turn'

const assistant = (stopReason: string, toolCallIds?: string[]): SessionTailMessage => ({
  role: 'assistant',
  stopReason,
  ...(toolCallIds ? { toolCallIds } : {}),
})
const result = (toolCallId: string): SessionTailMessage => ({ role: 'toolResult', toolCallId })

test('a clean finish is not an interruption', () => {
  assert.equal(interruptionReason([{ role: 'user' }, assistant('stop')]), null)
})

test('a turn ended by the user is not resumed', () => {
  // The user pressed stop; continuing would undo an explicit decision.
  assert.equal(interruptionReason([{ role: 'user' }, assistant('aborted')]), null)
})

test('a tool call with no result means the process died mid-turn', () => {
  assert.equal(
    interruptionReason([{ role: 'user' }, assistant('toolUse', ['call_1'])]),
    'tool-call-unanswered',
  )
})

test('a tool call that was answered is a finished step, not an interruption', () => {
  // Pi stops with `toolUse` between every step of a multi-step turn, so the
  // reason alone cannot mean "interrupted"; the missing result is the signal.
  assert.equal(
    interruptionReason([{ role: 'user' }, assistant('toolUse', ['call_1']), result('call_1')]),
    null,
  )
})

test('the last step running out with its result present finishes cleanly', () => {
  // A real session ends: call, result, then a final assistant answer.
  assert.equal(
    interruptionReason([
      { role: 'user' },
      assistant('toolUse', ['call_1']),
      result('call_1'),
      assistant('stop'),
    ]),
    null,
  )
})

test('a prompt with no reply at all means the agent was killed before answering', () => {
  assert.equal(interruptionReason([{ role: 'user' }]), 'no-reply')
})

test('an errored final answer is reported distinctly from lost work', () => {
  assert.equal(interruptionReason([{ role: 'user' }, assistant('error')]), 'errored')
})

test('an unknown stop reason claims nothing', () => {
  assert.equal(interruptionReason([{ role: 'user' }, assistant('somethingNew')]), null)
})

test('an empty transcript claims nothing', () => {
  assert.equal(interruptionReason([]), null)
})

test('only the last message decides, not an earlier unfinished-looking step', () => {
  assert.equal(
    interruptionReason([assistant('toolUse', ['call_1']), result('call_1'), assistant('stop')]),
    null,
  )
})

test('tailMessagesFrom ignores non-message records and keeps tool call ids', () => {
  const messages = tailMessagesFrom([
    { type: 'session', id: 'x' },
    { type: 'session_info', name: 'a title' },
    { type: 'thinking_level_change', thinkingLevel: 'high' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    {
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'toolCall', id: 'call_9', name: 'bash' },
        ],
      },
    },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'call_9', content: [{ type: 'text', text: 'ok' }] } },
  ])
  assert.deepEqual(
    messages.map((message) => [message.role, message.stopReason, message.toolCallId]),
    [
      ['user', undefined, undefined],
      ['assistant', 'toolUse', undefined],
      ['toolResult', undefined, 'call_9'],
    ],
  )
  assert.deepEqual(messages[1].toolCallIds, ['call_9'])
})

test('a continuation is sent only for an unfinished turn with the feature on', () => {
  const base = { enabled: true, prompt: 'continue', alreadyHandled: false }
  assert.equal(continuationPrompt({ ...base, reason: 'tool-call-unanswered' }), 'continue')
  assert.equal(continuationPrompt({ ...base, reason: 'no-reply' }), 'continue')
})

test('nothing is sent once the session has been handled, so a second open is silent', () => {
  // A start or a workspace switch reopens the same session; without this the
  // user would get the continuation prompt twice.
  assert.equal(continuationPrompt({ enabled: true, prompt: 'continue', alreadyHandled: true, reason: 'tool-call-unanswered' }), null)
})

test('nothing is sent when the feature is off or the turn finished', () => {
  assert.equal(continuationPrompt({ enabled: false, prompt: 'continue', alreadyHandled: false, reason: 'tool-call-unanswered' }), null)
  assert.equal(continuationPrompt({ enabled: true, prompt: 'continue', alreadyHandled: false, reason: null }), null)
})

test('an empty or whitespace prompt sends nothing rather than an empty message', () => {
  assert.equal(continuationPrompt({ enabled: true, prompt: '', alreadyHandled: false, reason: 'no-reply' }), null)
  assert.equal(continuationPrompt({ enabled: true, prompt: '   ', alreadyHandled: false, reason: 'no-reply' }), null)
  assert.equal(continuationPrompt({ enabled: true, prompt: undefined, alreadyHandled: false, reason: 'no-reply' }), null)
})

test('a custom prompt is sent trimmed', () => {
  assert.equal(continuationPrompt({ enabled: true, prompt: '  keep going  ', alreadyHandled: false, reason: 'no-reply' }), 'keep going')
})
