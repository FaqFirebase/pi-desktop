import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHAT_WIDTHS, DEFAULT_CHAT_WIDTH, isChatWidth } from './chat-width'

test('every listed chat width is accepted', () => {
  for (const width of CHAT_WIDTHS) assert.equal(isChatWidth(width), true)
})

test('the default chat width is a listed width', () => {
  assert.equal(isChatWidth(DEFAULT_CHAT_WIDTH), true)
})

test('unknown chat widths are rejected', () => {
  assert.equal(isChatWidth('wide'), false)
  assert.equal(isChatWidth(''), false)
  assert.equal(isChatWidth(1024), false)
  assert.equal(isChatWidth(null), false)
})
