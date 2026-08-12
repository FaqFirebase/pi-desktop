import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEditorGuard } from './editor-guard'

test('a fresh guard never prompts', () => {
  const guard = createEditorGuard()
  assert.equal(guard.needsPrompt(), false)
})

test('a dirty buffer prompts until the discard is confirmed', () => {
  const guard = createEditorGuard()
  guard.setDirty(true, 'notes.md')
  assert.equal(guard.needsPrompt(), true)

  guard.confirmDiscard()
  assert.equal(guard.needsPrompt(), false, 'the confirmed quit must proceed without a second ask')
})

test('new edits after a confirmed discard re-arm the prompt', () => {
  const guard = createEditorGuard()
  guard.setDirty(true, 'notes.md')
  guard.confirmDiscard()

  guard.setDirty(true, 'notes.md')

  assert.equal(guard.needsPrompt(), true, 'fresh edits are a fresh decision')
})

test('a clean buffer clears the prompt and the remembered file', () => {
  const guard = createEditorGuard()
  guard.setDirty(true, 'notes.md')

  guard.setDirty(false, null)

  assert.equal(guard.needsPrompt(), false)
  assert.equal(guard.promptMessage(), 'Discard unsaved changes?')
})

test('reset forgets dirty state and any prior confirmation', () => {
  const guard = createEditorGuard()
  guard.setDirty(true, 'notes.md')
  guard.confirmDiscard()

  guard.reset()

  assert.equal(guard.needsPrompt(), false)
  guard.setDirty(true, 'other.md')
  assert.equal(guard.needsPrompt(), true, 'a reloaded renderer starts the decision over')
})

test('promptMessage names the file when known', () => {
  const guard = createEditorGuard()
  guard.setDirty(true, 'notes.md')
  assert.equal(guard.promptMessage(), 'Discard unsaved changes to notes.md?')

  const nameless = createEditorGuard()
  nameless.setDirty(true, null)
  assert.equal(nameless.promptMessage(), 'Discard unsaved changes?')
})
