import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NEXT_STEPS_DEVICE_PATH, NEXT_STEPS_TOOL_NAME } from '../../../resources/next-steps'
import type { DisplayMessage } from './message-parsing'
import { isNextStepsCall, latestNextSteps, mayBeNextStepsCall, withoutNextStepsCalls } from './next-steps'

const ADD_TESTS = { label: 'Add tests', prompt: 'Add tests for calc.py.' }
const RUN_BUILD = { label: 'Run the build', prompt: 'Run the build.' }
const TIMESTAMP = 1_000

function user(id: string, content = 'Do the task'): DisplayMessage {
  return { id, role: 'user', content, timestamp: TIMESTAMP }
}

function assistant(id: string, content: string, toolCalls?: DisplayMessage['toolCalls'], thinking?: string): DisplayMessage {
  return { id, role: 'assistant', content, timestamp: TIMESTAMP, toolCalls, thinking }
}

function result(id: string, toolCallId: string, isError = false): DisplayMessage {
  return { id, role: 'toolResult', content: 'ok', timestamp: TIMESTAMP, toolCallId, isError }
}

function stepsCall(id: string, steps: unknown[]): NonNullable<DisplayMessage['toolCalls']>[number] {
  return { id, name: NEXT_STEPS_TOOL_NAME, arguments: JSON.stringify({ steps }) }
}

function deviceCall(id: string, steps: unknown[]): NonNullable<DisplayMessage['toolCalls']>[number] {
  return { id, name: 'write', arguments: JSON.stringify({ path: NEXT_STEPS_DEVICE_PATH, content: JSON.stringify({ steps }) }) }
}

const WRITE_CALL = { id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'calc.py', content: 'x' }) }

test('isNextStepsCall matches both call forms and nothing else', () => {
  assert.equal(isNextStepsCall(stepsCall('s1', [ADD_TESTS])), true)
  assert.equal(isNextStepsCall(deviceCall('s1', [ADD_TESTS])), true)
  assert.equal(isNextStepsCall(WRITE_CALL), false)
})

test('mayBeNextStepsCall hides a device write while its arguments still stream in', () => {
  const partial = (argumentsText: string) => mayBeNextStepsCall({ name: 'write', arguments: argumentsText })
  // Path first: the full device path, or text that may still become it.
  assert.equal(partial('{"path": "xd://suggest_next_steps", "content": "{\\"st'), true)
  assert.equal(partial('{"path":"xd://sugg'), true)
  // Content first: the steps JSON shows before the path does.
  assert.equal(partial('{"content": "{\\"steps\\": [{\\"label'), true)
  assert.equal(partial('{"content":"{ \\"steps\\":['), true)
  // Complete arguments still decide exactly.
  assert.equal(partial(deviceCall('s1', [ADD_TESTS]).arguments), true)
})

test('mayBeNextStepsCall leaves real file writes and other tools visible', () => {
  const partial = (argumentsText: string, name = 'write') => mayBeNextStepsCall({ name, arguments: argumentsText })
  assert.equal(partial('{"path": "calc.py", "content": "def add'), false)
  assert.equal(partial('{"path": "xd://other_tool"'), false)
  assert.equal(partial('{"content": "def add(a, b):'), false)
  // A JSON file whose text starts like steps shows as soon as its path arrives.
  assert.equal(partial('{"content": "{\\"steps\\": []}", "path": "plan.json"}'), false)
  assert.equal(partial('{"path": "xd://suggest_next_steps"', 'read'), false)
  assert.equal(partial(''), false)
  assert.equal(partial(WRITE_CALL.arguments), false)
})

test('mayBeNextStepsCall matches a direct call from its name alone', () => {
  assert.equal(mayBeNextStepsCall({ name: NEXT_STEPS_TOOL_NAME, arguments: '{"ste' }), true)
})

test('withoutNextStepsCalls drops the call, its result, and a message left empty', () => {
  const messages = [
    user('u1'),
    assistant('a1', '', [WRITE_CALL]),
    result('r1', 'w1'),
    assistant('a2', '', [stepsCall('s1', [ADD_TESTS])]),
    result('r2', 's1'),
    assistant('a3', 'Done.'),
  ]
  assert.deepEqual(withoutNextStepsCalls(messages).map((message) => message.id), ['u1', 'a1', 'r1', 'a3'])
})

test('withoutNextStepsCalls keeps the text, thinking and other calls of a message', () => {
  const [kept] = withoutNextStepsCalls([assistant('a1', 'Done.', [WRITE_CALL, deviceCall('s1', [ADD_TESTS])])])
  assert.equal(kept.content, 'Done.')
  assert.deepEqual(kept.toolCalls, [WRITE_CALL])

  const [thinkingOnly] = withoutNextStepsCalls([assistant('a2', '', [stepsCall('s2', [ADD_TESTS])], 'Pick steps.')])
  assert.equal(thinkingOnly.thinking, 'Pick steps.')
  assert.equal(thinkingOnly.toolCalls, undefined)
})

test('withoutNextStepsCalls returns the same list when there is nothing to hide', () => {
  const messages = [user('u1'), assistant('a1', '', [WRITE_CALL]), result('r1', 'w1')]
  assert.equal(withoutNextStepsCalls(messages), messages)
})

test('latestNextSteps reads the steps of the latest turn only', () => {
  const earlier = [user('u1'), assistant('a1', '', [stepsCall('s1', [ADD_TESTS])]), result('r1', 's1'), assistant('a2', 'Done.')]
  assert.deepEqual(latestNextSteps(earlier), [ADD_TESTS])
  assert.deepEqual(latestNextSteps([...earlier, user('u2', 'Next task')]), [])
  assert.deepEqual(latestNextSteps([...earlier, user('u2'), assistant('a3', 'No steps this time.')]), [])
})

test('latestNextSteps uses the last call that did not fail', () => {
  const messages = [
    user('u1'),
    assistant('a1', '', [deviceCall('s1', ['not an object'])]),
    result('r1', 's1', true),
    assistant('a2', '', [deviceCall('s2', [RUN_BUILD])]),
    result('r2', 's2'),
    assistant('a3', '', [stepsCall('s3', [ADD_TESTS])]),
    result('r3', 's3', true),
    assistant('a4', 'Done.'),
  ]
  assert.deepEqual(latestNextSteps(messages), [RUN_BUILD])
})

test('latestNextSteps returns no steps for a chat without any', () => {
  assert.deepEqual(latestNextSteps([]), [])
  assert.deepEqual(latestNextSteps([user('u1'), assistant('a1', 'Hello.')]), [])
})
