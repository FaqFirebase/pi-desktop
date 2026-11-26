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

function piModel(patch: Partial<ModelInfo>): ModelInfo {
  return { id: 'model', name: 'model', api: 'openai-completions', provider: 'provider', baseUrl: '', reasoning: true, input: ['text'], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...patch }
}

test('a Pi thinking map hides null levels and offers xhigh and max only when named', () => {
  // Ollama Cloud GLM 5.3 Flash as Pi reports it.
  const glm = piModel({ thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: 'max' } })
  assert.deepEqual(thinkingLevels(glm), ['off', 'low', 'high', 'xhigh'])
  assert.deepEqual(thinkingLevels(piModel({ thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } })), ['off', 'high', 'max'])
  assert.deepEqual(thinkingLevels(piModel({ thinkingLevelMap: { off: null } })), ['minimal', 'low', 'medium', 'high'])
})

test('a Pi model without a map offers the standard levels, and a non-reasoning model only off', () => {
  assert.deepEqual(thinkingLevels(piModel({})), ['off', 'minimal', 'low', 'medium', 'high'])
  assert.deepEqual(thinkingLevels(piModel({ reasoning: false, thinkingLevelMap: { high: 'high' } })), ['off'])
})

test('OMP efforts win over a Pi map, and an unknown model offers every level', () => {
  assert.deepEqual(thinkingLevels(piModel({ thinking: { efforts: ['low', 'high'] }, thinkingLevelMap: { low: null } })), ['off', 'low', 'high'])
  assert.deepEqual(thinkingLevels(null), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
})
