import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import { thinkingLevels, stepThinkingLevel } from './thinking-levels'

test('arrows lower and raise effort without wrapping at the boundaries', () => {
  const levels = thinkingLevels(undefined)
  assert.equal(stepThinkingLevel(levels, 'medium', -1), 'low')
  assert.equal(stepThinkingLevel(levels, 'medium', 1), 'high')
  assert.equal(stepThinkingLevel(levels, levels[0], -1), levels[0])
  assert.equal(stepThinkingLevel(levels, levels.at(-1)!, 1), levels.at(-1))
})

test('steps only through model-advertised efforts, including off once', () => {
  const model = { thinking: { efforts: ['off', '', 'low', 'high'] } } as ModelInfo
  const levels = thinkingLevels(model)
  assert.equal(stepThinkingLevel(levels, 'off', 1), 'low')
  assert.equal(stepThinkingLevel(levels, 'low', 1), 'high')
  assert.equal(stepThinkingLevel(levels, 'high', -1), 'low')
  assert.equal(stepThinkingLevel(levels, 'low', -1), 'off')
})

test('an unavailable current effort moves to a supported value', () => {
  const levels = ['off', 'low', 'high']
  assert.equal(stepThinkingLevel(levels, 'medium', 1), 'off')
  assert.equal(stepThinkingLevel(levels, 'medium', -1), 'off')
})
