import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCommitPushShortcut } from './commit-push-shortcut'

const commandP = {
  key: 'p', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false,
}

test('Command+P opens commit and push, regardless of key casing', () => {
  assert.equal(isCommitPushShortcut(commandP), true)
  assert.equal(isCommitPushShortcut({ ...commandP, key: 'P' }), true)
})

test('leaves Ctrl+P, typing, modified shortcuts and IME composition untouched', () => {
  for (const override of [
    { metaKey: false, ctrlKey: true },
    { metaKey: false },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
    { key: 'k' },
  ]) {
    assert.equal(isCommitPushShortcut({ ...commandP, ...override }), false)
  }
})
