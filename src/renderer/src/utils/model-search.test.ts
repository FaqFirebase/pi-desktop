import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import { filterModels, normalizeModelSearchText } from './model-search'

function model(partial: Pick<ModelInfo, 'id' | 'name' | 'provider'> & Partial<ModelInfo>): ModelInfo {
  return {
    api: 'openai-completions',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    contextWindow: 8000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...partial,
  }
}

const models: ModelInfo[] = [
  model({
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    contextWindow: 200000,
    reasoning: true,
  }),
  model({
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
  }),
  model({
    id: 'llama3.2',
    name: 'Llama 3.2',
    provider: 'ollama',
    contextWindow: 8000,
  }),
]

test('normalizeModelSearchText collapses separators', () => {
  assert.equal(normalizeModelSearchText('Claude-Sonnet_4'), 'claude sonnet 4')
})

test('filterModels returns all models for empty query', () => {
  assert.equal(filterModels(models, '').length, 3)
  assert.equal(filterModels(models, '   ').length, 3)
})

test('filterModels matches partial tokens across hyphenated slugs', () => {
  const hits = filterModels(models, 'sonnet 4')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'claude-sonnet-4')
})

test('filterModels matches provider or short id fragments', () => {
  assert.equal(filterModels(models, 'openai').length, 1)
  assert.equal(filterModels(models, 'gpt 4o')[0]?.id, 'gpt-4o')
})

test('filterModels requires every token (AND)', () => {
  assert.equal(filterModels(models, 'claude openai').length, 0)
})
