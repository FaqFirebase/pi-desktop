import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTerminalSlot, terminalKey, workspaceTerminalKeys } from './terminal-slot'

test('the shell slot keeps the workspace id as its key', () => {
  assert.equal(terminalKey('w1', 'shell'), 'w1')
})

test('the editor slot has its own key', () => {
  assert.equal(terminalKey('w1', 'editor'), 'w1#editor')
  assert.notEqual(terminalKey('w1', 'editor'), terminalKey('w1', 'shell'))
})

test('isTerminalSlot accepts the two slots only', () => {
  assert.equal(isTerminalSlot('editor'), true)
  assert.equal(isTerminalSlot('shell'), true)
  assert.equal(isTerminalSlot('tab2'), false)
  assert.equal(isTerminalSlot(undefined), false)
})

test('a workspace owns one key per slot', () => {
  assert.deepEqual(workspaceTerminalKeys('w1'), ['w1', 'w1#editor'])
})
