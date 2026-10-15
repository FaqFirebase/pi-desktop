import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  captureShortcut, duplicateShortcutOwner, matchesShortcut, formatShortcut, releasesShortcut, shortcutAccelerator, shortcutProblem,
  type ShortcutKeyEvent,
} from './keyboard-shortcuts'
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

test('Commit + Push uses the platform primary modifier, never the Super/Windows key', () => {
  const binding = DEFAULT_SETTINGS.shortcuts.commitPush!
  assert.equal(binding.startsWith('Mod+'), true)
  const press = { key: 'h', code: 'KeyH', altKey: false, shiftKey: true }
  assert.equal(matchesShortcut({ ...press, ctrlKey: false, metaKey: true }, binding, 'darwin'), true)
  assert.equal(matchesShortcut({ ...press, ctrlKey: true, metaKey: false }, binding, 'linux'), true)
  assert.equal(matchesShortcut({ ...press, ctrlKey: false, metaKey: true }, binding, 'win32'), false)
})

test('a recorded duplicate names the action that already owns the binding, whichever side the validator reports', () => {
  const defaults = DEFAULT_SETTINGS.shortcuts
  // Sidebar comes before Diff viewer, so the validator reports Diff viewer as the duplicate.
  const laterOwner = shortcutProblem({ ...defaults, sidebar: 'Mod+G' }, 'linux')
  assert.deepEqual(laterOwner, { kind: 'duplicate', action: 'diff', other: 'sidebar' })
  assert.equal(duplicateShortcutOwner(laterOwner, 'sidebar'), 'diff')
  const earlierOwner = shortcutProblem({ ...defaults, terminal: 'Mod+G' }, 'linux')
  assert.deepEqual(earlierOwner, { kind: 'duplicate', action: 'terminal', other: 'diff' })
  assert.equal(duplicateShortcutOwner(earlierOwner, 'terminal'), 'diff')
  assert.equal(duplicateShortcutOwner(earlierOwner, 'notes'), null)
  assert.equal(duplicateShortcutOwner(shortcutProblem({ ...defaults, sidebar: 'Mod+S' }, 'linux'), 'sidebar'), null)
  assert.equal(duplicateShortcutOwner(null, 'sidebar'), null)
})

test('saved remappings and disabled actions survive normalization; missing actions acquire defaults', () => {
  const stored = JSON.parse(JSON.stringify({ shortcuts: { diff: 'Mod+Shift+D', terminal: null, nextSession: 'Mod+J', newSession: null } }))
  const settings = normalizeStoredSettings(stored, ['en'])
  assert.equal(matchesShortcut(commandG, settings.shortcuts.diff, 'darwin'), false)
  assert.equal(matchesShortcut({ ...commandG, code: 'KeyD', key: 'D', shiftKey: true }, settings.shortcuts.diff, 'darwin'), true)
  assert.equal(matchesShortcut(commandG, settings.shortcuts.terminal, 'darwin'), false)
  assert.equal(settings.shortcuts.newSession, null)
  for (const platform of ['darwin', 'linux', 'win32']) {
    const event = { ...commandG, key: 'j', code: 'KeyJ', metaKey: platform === 'darwin', ctrlKey: platform !== 'darwin' }
    assert.equal(matchesShortcut(event, settings.shortcuts.nextSession, platform), true)
    assert.equal(matchesShortcut({ ...event, key: ']', code: 'BracketRight' }, settings.shortcuts.nextSession, platform), false)
    assert.equal(shortcutProblem(settings.shortcuts, platform), null)
  }
  assert.equal(settings.shortcuts.commandPalette, DEFAULT_SETTINGS.shortcuts.commandPalette)
  assert.equal(normalizeStoredSettings({ shortcuts: { diff: 42 } }, ['en']).shortcuts.diff, DEFAULT_SETTINGS.shortcuts.diff)
})

test('push to talk ends when its key or one of its modifiers comes up, not another key', () => {
  const binding = DEFAULT_SETTINGS.shortcuts.pushToTalk!
  const release = (key: string, code: string) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
  for (const platform of ['darwin', 'linux']) {
    assert.equal(releasesShortcut(release('t', 'KeyT'), binding, platform), true)
    assert.equal(releasesShortcut(release('Shift', 'ShiftLeft'), binding, platform), true)
    assert.equal(releasesShortcut(release('a', 'KeyA'), binding, platform), false)
    assert.equal(releasesShortcut(release('Alt', 'AltLeft'), binding, platform), false)
  }
  assert.equal(releasesShortcut(release('Meta', 'MetaLeft'), binding, 'darwin'), true)
  assert.equal(releasesShortcut(release('Control', 'ControlLeft'), binding, 'darwin'), false)
  assert.equal(releasesShortcut(release('Control', 'ControlLeft'), binding, 'linux'), true)
  assert.equal(releasesShortcut(release('t', 'KeyT'), 'T', 'linux'), false)
})

test('stored bindings become Electron accelerators for the system-wide key', () => {
  assert.equal(shortcutAccelerator('Mod+Shift+T'), 'CommandOrControl+Shift+T')
  assert.equal(shortcutAccelerator('Ctrl+Meta+Alt+F5'), 'Control+Super+Alt+F5')
  assert.equal(shortcutAccelerator('Mod+Backquote'), 'CommandOrControl+`')
  assert.equal(shortcutAccelerator('Mod+Quote'), "CommandOrControl+'")
  assert.equal(shortcutAccelerator('T'), null)
})

test('the system-wide dictation key is off by default and conflicts like any other shortcut', () => {
  const defaults = DEFAULT_SETTINGS.shortcuts
  assert.equal(defaults.globalDictation, null)
  assert.deepEqual(shortcutProblem({ ...defaults, globalDictation: 'Mod+Shift+T' }, 'linux'),
    { kind: 'duplicate', action: 'globalDictation', other: 'pushToTalk' })
  assert.equal(shortcutProblem({ ...defaults, globalDictation: 'Mod+V' }, 'linux')?.kind, 'reserved')
  assert.equal(shortcutProblem({ ...defaults, globalDictation: 'Mod+Alt+D' }, 'linux'), null)
})
