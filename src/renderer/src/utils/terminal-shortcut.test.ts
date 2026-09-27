import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTerminalShortcut } from './terminal-shortcut'

const shortcut = {
  key: '`', code: 'Backquote', ctrlKey: true, metaKey: false,
  altKey: false, shiftKey: false, isComposing: false
}

test('recognizes Ctrl+backtick by character or physical key', () => {
  assert.equal(isTerminalShortcut(shortcut), true)
  assert.equal(isTerminalShortcut({ ...shortcut, code: '' }), true)
  assert.equal(isTerminalShortcut({ ...shortcut, key: 'Dead' }), true)
})

test('ignores other keys, modifiers, and composition', () => {
  for (const override of [
    { ctrlKey: false }, { metaKey: true }, { altKey: true },
    { shiftKey: true }, { isComposing: true }, { key: 'k', code: 'KeyK' }
  ]) {
    assert.equal(isTerminalShortcut({ ...shortcut, ...override }), false)
  }
})
