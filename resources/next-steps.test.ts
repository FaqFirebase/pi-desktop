import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_NEXT_STEPS,
  MAX_NEXT_STEP_LABEL_LENGTH,
  MAX_NEXT_STEP_PROMPT_LENGTH,
  NEXT_STEPS_DEVICE_PATH,
  NEXT_STEPS_GUIDANCE,
  NEXT_STEPS_PROMPT,
  NEXT_STEPS_PROMPT_TAG,
  NEXT_STEPS_TOOL_NAME,
  NEXT_STEPS_TOOL_PARAMETERS,
  isNextStepsDeviceWrite,
  normalizeNextSteps,
  parseNextStepsToolCall,
} from './next-steps'

const ADD_TESTS = { label: 'Add tests', prompt: 'Add tests for the parser.' }
const RUN_BUILD = { label: 'Run the build', prompt: 'Run the build and fix any errors.' }

test('normalizeNextSteps keeps well-formed steps in order', () => {
  assert.deepEqual(normalizeNextSteps({ steps: [ADD_TESTS, RUN_BUILD] }), [ADD_TESTS, RUN_BUILD])
})

test('normalizeNextSteps trims text and drops blank or malformed steps', () => {
  assert.deepEqual(
    normalizeNextSteps({
      steps: [
        { label: '  Add tests  ', prompt: '\n Add tests for the parser. \n' },
        { label: '   ', prompt: 'No label' },
        { label: 'No prompt', prompt: '' },
        { label: 7, prompt: 'Wrong type' },
        null,
        'a string',
      ],
    }),
    [ADD_TESTS]
  )
})

test('normalizeNextSteps drops a step that repeats an earlier prompt', () => {
  assert.deepEqual(
    normalizeNextSteps({ steps: [ADD_TESTS, { label: 'Tests again', prompt: ADD_TESTS.prompt }] }),
    [ADD_TESTS]
  )
})

test('normalizeNextSteps keeps at most MAX_NEXT_STEPS steps', () => {
  const steps = Array.from({ length: MAX_NEXT_STEPS + 2 }, (_, index) => ({ label: `Step ${index}`, prompt: `Do step ${index}.` }))
  const kept = normalizeNextSteps({ steps })
  assert.equal(kept.length, MAX_NEXT_STEPS)
  assert.deepEqual(kept, steps.slice(0, MAX_NEXT_STEPS))
})

test('normalizeNextSteps shortens a long label and a long prompt', () => {
  const [step] = normalizeNextSteps({
    steps: [{ label: 'x'.repeat(MAX_NEXT_STEP_LABEL_LENGTH + 10), prompt: 'y'.repeat(MAX_NEXT_STEP_PROMPT_LENGTH + 10) }],
  })
  assert.equal(step.label.length, MAX_NEXT_STEP_LABEL_LENGTH)
  assert.ok(step.label.endsWith('…'))
  assert.equal(step.prompt.length, MAX_NEXT_STEP_PROMPT_LENGTH)
})

test('normalizeNextSteps returns no steps for input that is not a steps object', () => {
  assert.deepEqual(normalizeNextSteps(null), [])
  assert.deepEqual(normalizeNextSteps('steps'), [])
  assert.deepEqual(normalizeNextSteps({ steps: 'Add tests' }), [])
  assert.deepEqual(normalizeNextSteps({}), [])
})

const DEVICE_WRITE = 'write'

function deviceWriteArguments(content: string, path = NEXT_STEPS_DEVICE_PATH): string {
  return JSON.stringify({ path, content })
}

test('parseNextStepsToolCall reads the JSON a direct call carries', () => {
  assert.deepEqual(parseNextStepsToolCall(NEXT_STEPS_TOOL_NAME, JSON.stringify({ steps: [RUN_BUILD] })), [RUN_BUILD])
  assert.deepEqual(parseNextStepsToolCall(NEXT_STEPS_TOOL_NAME, '{not json'), [])
})

test('parseNextStepsToolCall reads the steps OMP writes to the tool device', () => {
  const content = JSON.stringify({ steps: [ADD_TESTS] })
  assert.deepEqual(parseNextStepsToolCall(DEVICE_WRITE, deviceWriteArguments(content)), [ADD_TESTS])
  assert.deepEqual(parseNextStepsToolCall(DEVICE_WRITE, deviceWriteArguments('{not json')), [])
  assert.deepEqual(parseNextStepsToolCall(DEVICE_WRITE, JSON.stringify({ path: NEXT_STEPS_DEVICE_PATH })), [])
})

test('parseNextStepsToolCall returns null for any other call', () => {
  const content = JSON.stringify({ steps: [ADD_TESTS] })
  assert.equal(parseNextStepsToolCall(DEVICE_WRITE, deviceWriteArguments(content, 'notes.json')), null)
  assert.equal(parseNextStepsToolCall(DEVICE_WRITE, deviceWriteArguments(content, 'xd://other_tool')), null)
  assert.equal(parseNextStepsToolCall('read', JSON.stringify({ path: NEXT_STEPS_DEVICE_PATH })), null)
})

test('isNextStepsDeviceWrite matches a write to the next-steps device only', () => {
  assert.equal(isNextStepsDeviceWrite(DEVICE_WRITE, { path: NEXT_STEPS_DEVICE_PATH, content: '{}' }), true)
  assert.equal(isNextStepsDeviceWrite(NEXT_STEPS_TOOL_NAME, { steps: [] }), false)
  assert.equal(isNextStepsDeviceWrite(DEVICE_WRITE, { path: 'xd://other_tool', content: '{}' }), false)
  assert.equal(isNextStepsDeviceWrite(DEVICE_WRITE, { path: NEXT_STEPS_TOOL_NAME }), false)
  assert.equal(isNextStepsDeviceWrite('bash', { path: NEXT_STEPS_DEVICE_PATH }), false)
  assert.equal(isNextStepsDeviceWrite(DEVICE_WRITE, null), false)
})

test('the tool schema and the prompt agree with the limits', () => {
  assert.equal(NEXT_STEPS_TOOL_PARAMETERS.properties.steps.maxItems, MAX_NEXT_STEPS)
  assert.deepEqual(NEXT_STEPS_TOOL_PARAMETERS.required, ['steps'])
  assert.ok(NEXT_STEPS_GUIDANCE.includes(NEXT_STEPS_TOOL_NAME))
  assert.ok(NEXT_STEPS_GUIDANCE.includes(`1 to ${MAX_NEXT_STEPS}`))
  assert.equal(NEXT_STEPS_PROMPT, `<${NEXT_STEPS_PROMPT_TAG}>\n${NEXT_STEPS_GUIDANCE}\n</${NEXT_STEPS_PROMPT_TAG}>`)
})
