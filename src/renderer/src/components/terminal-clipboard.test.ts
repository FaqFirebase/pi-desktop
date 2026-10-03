import assert from 'node:assert/strict'
import { isNativeClipboardShortcut, usesCtrlClipboardShortcuts, type TerminalKeyEvent } from './terminal-clipboard'

const ctrl = (key: string, extra: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
  key,
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
})

assert.equal(usesCtrlClipboardShortcuts('win32'), true)
assert.equal(usesCtrlClipboardShortcuts('linux'), false)
assert.equal(usesCtrlClipboardShortcuts('darwin'), false)

// Windows: Ctrl+V always pastes, with or without a selection.
assert.equal(isNativeClipboardShortcut(ctrl('v'), 'win32', false), true)
assert.equal(isNativeClipboardShortcut(ctrl('V'), 'win32', true), true)

// Windows: Ctrl+C copies a selection, else it stays ^C for the shell.
assert.equal(isNativeClipboardShortcut(ctrl('c'), 'win32', true), true)
assert.equal(isNativeClipboardShortcut(ctrl('c'), 'win32', false), false)

// Extra modifiers keep xterm's own handling.
assert.equal(isNativeClipboardShortcut(ctrl('v', { shiftKey: true }), 'win32', false), false)
assert.equal(isNativeClipboardShortcut(ctrl('v', { altKey: true }), 'win32', false), false)
assert.equal(isNativeClipboardShortcut(ctrl('v', { ctrlKey: false }), 'win32', false), false)

// Other keys and other platforms are untouched.
assert.equal(isNativeClipboardShortcut(ctrl('a'), 'win32', true), false)
assert.equal(isNativeClipboardShortcut(ctrl('v'), 'linux', false), false)
assert.equal(isNativeClipboardShortcut(ctrl('c'), 'darwin', true), false)
