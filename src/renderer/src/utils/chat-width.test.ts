import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composerColumnClass, messageColumnClass } from './chat-width'

test('the normal width aligns the composer with the readable message column', () => {
  assert.equal(messageColumnClass('normal'), 'max-w-5xl')
  assert.equal(composerColumnClass('normal'), messageColumnClass('normal'))
})

test('the full width removes the column caps', () => {
  assert.equal(messageColumnClass('full'), 'max-w-none')
  assert.equal(composerColumnClass('full'), 'max-w-none')
})
