import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageColumnClass } from './chat-width'

test('the normal width is a readable column for messages, composer and the empty chat', () => {
  assert.equal(messageColumnClass('normal'), 'max-w-3xl')
})

test('the full width removes the column cap', () => {
  assert.equal(messageColumnClass('full'), 'max-w-none')
})
