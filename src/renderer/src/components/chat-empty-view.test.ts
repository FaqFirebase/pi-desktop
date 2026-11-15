import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isEmptyChatView, type ChatViewContent } from './chat-empty-view'

const NEW_CHAT: ChatViewContent = {
  sessionLoading: false,
  messageCount: 0,
  isStreaming: false,
  councilOnScreen: false,
}

test('a new chat with nothing in it shows the start screen', () => {
  assert.equal(isEmptyChatView(NEW_CHAT), true)
})

test('a council run on screen leaves the start screen, so its panel shows', () => {
  assert.equal(isEmptyChatView({ ...NEW_CHAT, councilOnScreen: true }), false)
})

test('loading, messages or a streaming turn leave the start screen', () => {
  assert.equal(isEmptyChatView({ ...NEW_CHAT, sessionLoading: true }), false)
  assert.equal(isEmptyChatView({ ...NEW_CHAT, messageCount: 1 }), false)
  assert.equal(isEmptyChatView({ ...NEW_CHAT, isStreaming: true }), false)
})
