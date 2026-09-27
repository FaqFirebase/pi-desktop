import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureShortcut, matchesShortcut, formatShortcut, shortcutProblem, type ShortcutKeyEvent } from './keyboard-shortcuts'
import { DEFAULT_SETTINGS } from './default-settings'
import { normalizeStoredSettings } from './app-settings'

const commandG: ShortcutKeyEvent = { key: 'g', code: 'KeyG', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }

test('diff opens with Command+G on macOS and Ctrl+G elsewhere, not plain typing', () => {
  const binding = DEFAULT_SETTINGS.shortcuts.diff
  assert.equal(matchesShortcut(commandG, binding, 'darwin'), true)
  for (const platform of ['linux', 'win32']) {
    assert.equal(matchesShortcut({ ...commandG, metaKey: false, ctrlKey: true }, binding, platform), true)
    assert.equal(matchesShortcut(commandG, binding, platform), false)
  }
  for (const change of [{ metaKey: false }, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(matchesShortcut({ ...commandG, ...change }, binding, 'darwin'), false)
  }
})

test('recorded shortcuts round-trip modifiers and physical keys on different layouts', () => {
  for (const platform of ['darwin', 'win32']) {
    const event = { ...commandG, key: 'Dead', code: 'Backquote', shiftKey: true, altKey: true }
    const binding = captureShortcut(event, platform)
    assert.ok(binding)
    assert.equal(matchesShortcut(event, binding, platform), true)
    assert.equal(matchesShortcut({ ...event, shiftKey: false }, binding, platform), false)
  }
  assert.equal(captureShortcut({ ...commandG, metaKey: false }, 'darwin'), null)
  assert.equal(captureShortcut({ ...commandG, isComposing: true }, 'darwin'), null)
  assert.equal(formatShortcut('Mod+Shift+Comma', 'darwin'), 'Cmd+Shift+,')
  assert.equal(formatShortcut('Mod+G', 'win32'), 'Ctrl+G')
  assert.equal(matchesShortcut({ ...commandG, code: undefined, key: 'G' }, 'Mod+G', 'darwin'), true)
})

test('conflicts account for primary-modifier aliases and reserved native/editor actions', () => {
  const defaults = DEFAULT_SETTINGS.shortcuts
  for (const platform of ['darwin', 'linux', 'win32']) assert.equal(shortcutProblem(defaults, platform), null)
  assert.deepEqual(shortcutProblem({ ...defaults, terminal: 'Meta+G' }, 'darwin'), { kind: 'duplicate', action: 'terminal', other: 'diff' })
  assert.equal(shortcutProblem({ ...defaults, diff: 'Mod+S' }, 'darwin')?.kind, 'reserved')
  assert.equal(shortcutProblem({ ...defaults, diff: 'Ctrl+P' }, 'linux')?.kind, 'reserved')
  assert.equal(shortcutProblem({ ...defaults, diff: 'G' }, 'darwin')?.kind, 'invalid')
  assert.equal(shortcutProblem({ ...defaults, diff: 'Mod+Ctrl+G' }, 'darwin')?.kind, 'invalid')
  assert.equal(shortcutProblem({ ...defaults, diff: null }, 'darwin'), null)
})

test('saved remappings and disabled actions survive normalization; missing actions acquire defaults', () => {
  const stored = JSON.parse(JSON.stringify({ shortcuts: { diff: 'Mod+Shift+D', terminal: null } }))
  const settings = normalizeStoredSettings(stored, ['en'])
  assert.equal(matchesShortcut(commandG, settings.shortcuts.diff, 'darwin'), false)
  assert.equal(matchesShortcut({ ...commandG, code: 'KeyD', key: 'D', shiftKey: true }, settings.shortcuts.diff, 'darwin'), true)
  assert.equal(matchesShortcut(commandG, settings.shortcuts.terminal, 'darwin'), false)
  assert.equal(settings.shortcuts.commandPalette, DEFAULT_SETTINGS.shortcuts.commandPalette)
  assert.equal(normalizeStoredSettings({ shortcuts: { diff: 42 } }, ['en']).shortcuts.diff, DEFAULT_SETTINGS.shortcuts.diff)
})
