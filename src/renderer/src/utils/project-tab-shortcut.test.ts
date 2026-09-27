import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectTabShortcutIndex } from './project-tab-shortcut'

const shortcut = {
  key: ']', code: 'BracketRight', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false
}

test('project shortcuts navigate in both directions and wrap', () => {
  assert.equal(projectTabShortcutIndex(shortcut, 0, 3), 1)
  assert.equal(projectTabShortcutIndex(shortcut, 2, 3), 0)
  const previous = { ...shortcut, key: '[', code: 'BracketLeft' }
  assert.equal(projectTabShortcutIndex(previous, 2, 3), 1)
  assert.equal(projectTabShortcutIndex(previous, 0, 3), 2)
})

test('recognizes shifted brackets and physical bracket keys', () => {
  assert.equal(projectTabShortcutIndex({ ...shortcut, key: '}' }, 0, 3), 1)
  assert.equal(projectTabShortcutIndex({ ...shortcut, key: '{', code: 'BracketLeft' }, 1, 3), 0)
  assert.equal(projectTabShortcutIndex({ ...shortcut, key: 'other' }, 0, 3), 1)
  assert.equal(projectTabShortcutIndex({ ...shortcut, code: '' }, 0, 3), 1)
})

test('ignores unrelated shortcuts and empty project lists', () => {
  for (const change of [
    { metaKey: false }, { shiftKey: false }, { ctrlKey: true }, { altKey: true },
    { key: 'a', code: 'KeyA' }
  ]) {
    assert.equal(projectTabShortcutIndex({ ...shortcut, ...change }, 0, 3), null)
  }
  assert.equal(projectTabShortcutIndex(shortcut, -1, 0), null)
  assert.equal(projectTabShortcutIndex(shortcut, 0, 1), 0)
  assert.equal(projectTabShortcutIndex(shortcut, -1, 3), 0)
  assert.equal(projectTabShortcutIndex({ ...shortcut, key: '[', code: 'BracketLeft' }, -1, 3), 2)
})
