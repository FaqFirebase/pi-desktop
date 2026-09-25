import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyInterim } from './voice-composer'

test('first interim inserts text at the anchor and reports its length', () => {
  const r = applyInterim('Hi ', 3, 0, 'hello')
  assert.equal(r.value, 'Hi hello')
  assert.equal(r.interimLength, 5)
  assert.equal(r.caret, 8)
})

test('a growing interim replaces the previous interim, not the surrounding text', () => {
  // Anchor 3, previous interim "hello" (len 5) already in the box.
  const r = applyInterim('Hi hello', 3, 5, 'hello there')
  assert.equal(r.value, 'Hi hello there')
  assert.equal(r.interimLength, 11)
  assert.equal(r.caret, 14)
})

test('interim replacement preserves text typed after the anchor region', () => {
  const r = applyInterim('Hi hello!', 3, 5, 'hey')
  assert.equal(r.value, 'Hi hey!')
  assert.equal(r.interimLength, 3)
})

test('a shorter correction shrinks the interim region correctly', () => {
  const r = applyInterim('Hi hello there', 3, 11, 'hello')
  assert.equal(r.value, 'Hi hello')
  assert.equal(r.interimLength, 5)
})
