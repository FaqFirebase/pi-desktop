import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isEditorId, resolvePreferredEditor } from './editors'

test('isEditorId accepts table ids only', () => {
  assert.equal(isEditorId('vscode'), true)
  assert.equal(isEditorId('notepad'), false)
  assert.equal(isEditorId(null), false)
})

test('a saved editor that is still installed is used', () => {
  const zed = { id: 'zed', name: 'Zed', inTerminal: false } as const
  assert.deepEqual(resolvePreferredEditor('zed', [zed]), { editor: zed, missing: false })
})

test('a saved editor that is gone falls back to System default with a note', () => {
  assert.deepEqual(resolvePreferredEditor('zed', []), { editor: null, missing: true })
})

test('System default is never reported missing', () => {
  assert.deepEqual(resolvePreferredEditor(null, []), { editor: null, missing: false })
})
