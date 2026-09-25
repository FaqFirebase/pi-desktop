import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { useAppStore } from '../store'
import { openDiffFile } from './diff-viewer'

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { piDesktop: { ui: { setEditorDirty: () => {} } } },
  })
  useAppStore.setState({
    activeWorkspace: {
      id: 'project', name: 'Project', path: '/project',
      createdAt: 0, lastActiveAt: 0, color: '',
    },
    currentView: 'diff',
    chatSidePanel: 'diff',
    previewTarget: null,
    editorDirty: false,
  })
})

test('opens the diff path in the editor and reveals the chat preview', async () => {
  await openDiffFile({ newPath: 'src/new name.ts', isDeleted: false })
  const state = useAppStore.getState()
  assert.deepEqual(state.previewTarget, {
    kind: 'code', name: 'new name.ts', path: '/project/src/new name.ts', relativePath: 'src/new name.ts',
  })
  assert.equal(state.currentView, 'chat')
  assert.equal(state.chatSidePanel, null)
})

test('routes images to the image viewer and preserves Windows paths', async () => {
  const workspace = useAppStore.getState().activeWorkspace!
  useAppStore.setState({ activeWorkspace: { ...workspace, path: 'C:\\project\\' } })
  await openDiffFile({ newPath: 'assets/image.png', isDeleted: false })
  assert.equal(useAppStore.getState().previewTarget?.kind, 'image')
  assert.equal(useAppStore.getState().previewTarget?.path, 'C:\\project\\assets\\image.png')
})

test('canceling the unsaved-editor confirmation keeps the diff open', async () => {
  useAppStore.setState({ editorDirty: true })
  const opening = openDiffFile({ newPath: 'other.ts', isDeleted: false })
  assert.ok(useAppStore.getState().confirmRequest)
  useAppStore.getState().resolveConfirm(false)
  await opening
  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().currentView, 'diff')
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('does not open deleted files or files without an active workspace', async () => {
  await openDiffFile({ newPath: 'deleted.ts', isDeleted: true })
  assert.equal(useAppStore.getState().previewTarget, null)
  useAppStore.setState({ activeWorkspace: null })
  await openDiffFile({ newPath: 'file.ts', isDeleted: false })
  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().currentView, 'diff')
})
