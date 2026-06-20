import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeForkMessages, type ForkPoint } from './fork-point'

test('returns [] for non-array input', () => {
  assert.deepEqual(normalizeForkMessages(null), [])
  assert.deepEqual(normalizeForkMessages({}), [])
})

test('maps entryId + text fields', () => {
  const r = normalizeForkMessages([
    { entryId: 'a1', text: 'first message' },
    { entryId: 'b2', text: 'second' },
  ])
  assert.deepEqual(r, [
    { entryId: 'a1', text: 'first message' },
    { entryId: 'b2', text: 'second' },
  ] satisfies ForkPoint[])
})

test('falls back to id and content field names', () => {
  const r = normalizeForkMessages([{ id: 'x', content: 'hello' }])
  assert.deepEqual(r, [{ entryId: 'x', text: 'hello' }])
})

test('skips entries without an id', () => {
  const r = normalizeForkMessages([{ text: 'no id' }, { entryId: 'ok', text: 't' }])
  assert.equal(r.length, 1)
  assert.equal(r[0].entryId, 'ok')
})
