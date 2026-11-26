import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shownSlotFor, withEditorTerminal, withoutEditorTerminal, type EditorTerminalState } from './editor-terminal-state'

const empty: EditorTerminalState = { editorTerminalWorkspaces: [], shownTerminalSlot: {} }

test('opening an editor shows the editor slot once', () => {
  const once = withEditorTerminal(empty, 'w')
  assert.deepEqual(withEditorTerminal(once, 'w'), { editorTerminalWorkspaces: ['w'], shownTerminalSlot: { w: 'editor' } })
  assert.equal(shownSlotFor(once, 'w'), 'editor')
})

test('closing the editor shows the shell again', () => {
  const state = withoutEditorTerminal(withEditorTerminal(empty, 'w'), 'w')
  assert.equal(shownSlotFor(state, 'w'), 'shell')
  assert.deepEqual(state.editorTerminalWorkspaces, [])
})

test('the editor slot is never shown without a live editor', () => {
  assert.equal(shownSlotFor({ editorTerminalWorkspaces: [], shownTerminalSlot: { w: 'editor' } }, 'w'), 'shell')
})

test('a workspace with no choice shows the shell', () => {
  assert.equal(shownSlotFor(empty, 'w'), 'shell')
})

test('one workspace editor leaves the others alone', () => {
  const state = withoutEditorTerminal(withEditorTerminal(withEditorTerminal(empty, 'a'), 'b'), 'a')
  assert.deepEqual(state, { editorTerminalWorkspaces: ['b'], shownTerminalSlot: { a: 'shell', b: 'editor' } })
})
