import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendToSystemPrompt } from './system-prompt'

test('appendToSystemPrompt keeps the shape each engine uses', () => {
  assert.equal(appendToSystemPrompt('base', 'block'), 'base\n\nblock')
  assert.deepEqual(appendToSystemPrompt(['a', 'b'], 'block'), ['a', 'b', 'block'])
})
