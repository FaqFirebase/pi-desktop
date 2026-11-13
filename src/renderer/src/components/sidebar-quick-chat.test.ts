import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quickChatEntryTitle } from './sidebar-quick-chat'

const SHORTCUT = 'Mod+Alt+Q'

test('the Quick Chat button names the saved shortcut in each platform spelling', () => {
  assert.equal(quickChatEntryTitle(SHORTCUT, 'linux'), 'Open Quick Chat (Ctrl+Alt+Q)')
  assert.equal(quickChatEntryTitle(SHORTCUT, 'win32'), 'Open Quick Chat (Ctrl+Alt+Q)')
  assert.equal(quickChatEntryTitle(SHORTCUT, 'darwin'), 'Open Quick Chat (Cmd+Alt+Q)')
})

test('with no shortcut, the Quick Chat button says where to set one', () => {
  assert.equal(quickChatEntryTitle(null, 'linux'), 'Open Quick Chat. Set a shortcut in Settings > Keyboard shortcuts.')
})
