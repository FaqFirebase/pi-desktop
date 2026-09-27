import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionTabShortcutIndex } from './session-tab-shortcut'

const shortcut = {
  key: ']', ctrlKey: false, shiftKey: false, metaKey: true, altKey: false
}

test('Command+] follows visible session order and wraps', () => {
  assert.equal(sessionTabShortcutIndex(shortcut, 0, 3), 1)
  assert.equal(sessionTabShortcutIndex(shortcut, 2, 3), 0)
})

test('Command+[ moves backward and wraps', () => {
  const previous = { ...shortcut, key: '[' }
  assert.equal(sessionTabShortcutIndex(previous, 2, 3), 1)
  assert.equal(sessionTabShortcutIndex(previous, 0, 3), 2)
})

test('leaves normal Tab and unrelated shortcuts alone', () => {
  for (const change of [
    { metaKey: false }, { ctrlKey: true }, { metaKey: false, ctrlKey: true },
    { altKey: true }, { shiftKey: true },
    { key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'a' }
  ]) {
    assert.equal(sessionTabShortcutIndex({ ...shortcut, ...change }, 0, 3), null)
  }
  assert.equal(sessionTabShortcutIndex({ ...shortcut, metaKey: false, shiftKey: true }, 0, 3), null)
})

test('handles empty, single, and not-yet-selected session lists', () => {
  assert.equal(sessionTabShortcutIndex(shortcut, -1, 0), null)
  assert.equal(sessionTabShortcutIndex(shortcut, 0, 1), 0)
  assert.equal(sessionTabShortcutIndex({ ...shortcut, key: '[' }, 0, 1), 0)
  assert.equal(sessionTabShortcutIndex(shortcut, -1, 3), 0)
  assert.equal(sessionTabShortcutIndex({ ...shortcut, key: '[' }, -1, 3), 2)
})
