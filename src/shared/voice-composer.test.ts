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

test('dictation after a word gets a space, so the words do not run together', () => {
  const r = applyInterim('draft', 5, 0, 'hello')
  assert.equal(r.value, 'draft hello')
  assert.equal(r.interimLength, 6)
  assert.equal(r.caret, 11)
  assert.equal(applyInterim('Hi,', 3, 0, 'hello').value, 'Hi, hello')
})

test('dictation before a word gets a space after it, and the caret stays after the words', () => {
  const r = applyInterim('Hi world', 3, 0, 'big')
  assert.equal(r.value, 'Hi big world')
  assert.equal(r.interimLength, 4)
  assert.equal(r.caret, 6)
})

test('no space goes after an opening bracket or quote, or before punctuation', () => {
  assert.equal(applyInterim('(', 1, 0, 'hello').value, '(hello')
  assert.equal(applyInterim('"', 1, 0, 'hello').value, '"hello')
  assert.equal(applyInterim('Hi .', 2, 0, 'there').value, 'Hi there .')
  assert.equal(applyInterim('Hi!', 2, 0, 'there').value, 'Hi there!')
})

test('the spaces are part of the interim region, so a rewrite or an empty final leaves none behind', () => {
  const first = applyInterim('draft', 5, 0, 'hello')
  const grown = applyInterim(first.value, 5, first.interimLength, 'hello there')
  assert.equal(grown.value, 'draft hello there')
  const emptied = applyInterim(grown.value, 5, grown.interimLength, '')
  assert.equal(emptied.value, 'draft')
  assert.equal(emptied.interimLength, 0)
  assert.equal(emptied.caret, 5)
})
