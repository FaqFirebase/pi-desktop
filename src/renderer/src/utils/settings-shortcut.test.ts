import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSettingsShortcut } from './settings-shortcut'

const commandComma = {
  key: ',', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false,
}

test('Command+, opens settings only on macOS', () => {
  assert.equal(isSettingsShortcut(commandComma, 'darwin'), true)
  for (const platform of ['win32', 'linux']) {
    assert.equal(isSettingsShortcut(commandComma, platform), false)
  }
})

test('other keys, modifiers and composition do not open settings', () => {
  for (const change of [
    { key: 'k' }, { metaKey: false }, { ctrlKey: true },
    { altKey: true }, { shiftKey: true }, { isComposing: true },
  ]) {
    assert.equal(isSettingsShortcut({ ...commandComma, ...change }, 'darwin'), false)
  }
})
