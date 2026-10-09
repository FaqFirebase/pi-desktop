import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EditorState, type Extension } from '@codemirror/state'
import { keymap, type KeyBinding } from '@codemirror/view'
import { lintKeymap } from '@codemirror/lint'
import { basicSetup } from 'codemirror'
import { codeEditorSetup } from './code-editor-setup'

function boundKeys(extension: Extension): string[] {
  const bindings: readonly KeyBinding[] = EditorState.create({ extensions: extension }).facet(keymap).flat()
  return bindings.flatMap((binding) => [binding.key, binding.mac, binding.win, binding.linux])
    .filter((key): key is string => key !== undefined)
    .sort()
}

test('the editor keymap leaves Mod+Shift+M to the app: there is no linter behind the lint panel', () => {
  assert.equal(boundKeys(codeEditorSetup).includes('Mod-Shift-m'), false)
})

test('the editor keeps every other basicSetup key, so only the lint keys change', () => {
  const lintKeys = new Set(boundKeys(lintKeymap.map((binding) => keymap.of([binding]))))
  assert.deepEqual(boundKeys(codeEditorSetup), boundKeys(basicSetup).filter((key) => !lintKeys.has(key)))
})

test('the indent, find-next and fold keys the app shortcuts now yield to are still bound', () => {
  const keys = boundKeys(codeEditorSetup)
  for (const key of ['Mod-[', 'Mod-]', 'Mod-g', 'Ctrl-Shift-[', 'Ctrl-Shift-]']) {
    assert.equal(keys.includes(key), true, key)
  }
})
