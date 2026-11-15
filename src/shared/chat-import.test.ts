import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IMPORTED_MESSAGE_MODEL, IMPORTED_MESSAGE_PROVIDER, isImportedMessage } from './chat-import'

test('a message with the import provider marker is imported', () => {
  assert.equal(isImportedMessage({ provider: IMPORTED_MESSAGE_PROVIDER, model: IMPORTED_MESSAGE_MODEL }), true)
})

test('a message from a real provider is not imported', () => {
  assert.equal(isImportedMessage({ provider: 'anthropic', model: 'claude' }), false)
  assert.equal(isImportedMessage({}), false)
})
