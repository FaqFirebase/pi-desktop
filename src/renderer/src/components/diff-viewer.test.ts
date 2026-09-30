import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { useAppStore } from '../store'
import { discardDiffFiles, openDiffFile } from './diff-viewer'
import { filterSessionDiffFiles } from '../utils/session-diff'

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { piDesktop: { ui: { setEditorDirty: () => {} }, files: { discardDiff: async () => {} } } },
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
    confirmRequest: null,
  })
})

test('opens the exact diff path and reveals the editor from either diff surface', async () => {
  await openDiffFile({ newPath: 'src/new name.ts', isDeleted: false }, '')
  const state = useAppStore.getState()
  assert.deepEqual(state.previewTarget, {
    kind: 'code', name: 'new name.ts', path: '/project/src/new name.ts', relativePath: 'src/new name.ts',
  })
  assert.equal(state.currentView, 'chat')
  assert.equal(state.chatSidePanel, null)
})

test('opens monorepo diff paths relative to the workspace and skips files outside it', async () => {
  useAppStore.setState({ activeWorkspace: { ...useAppStore.getState().activeWorkspace!, path: '/repo/pkg/app' } })
  await openDiffFile({ newPath: 'root.ts', isDeleted: false }, 'pkg/app/')
  assert.equal(useAppStore.getState().previewTarget, null)
  await openDiffFile({ newPath: 'pkg/app2/a.ts', isDeleted: false }, 'pkg/app/')
  assert.equal(useAppStore.getState().previewTarget, null)
  await openDiffFile({ newPath: 'pkg/app/src/a.ts', isDeleted: false }, 'pkg/app/')
  assert.deepEqual(useAppStore.getState().previewTarget, {
    kind: 'code', name: 'a.ts', path: '/repo/pkg/app/src/a.ts', relativePath: 'src/a.ts',
  })
})

test('discard closes a monorepo preview opened by its workspace-relative path', async () => {
  const file = { oldPath: 'pkg/app/a.ts', newPath: 'pkg/app/a.ts', patch: 'patch-a' }
  useAppStore.setState({ previewTarget: {
    kind: 'code', path: '/repo/pkg/app/a.ts', relativePath: 'a.ts', name: 'a.ts',
  } })
  const result = discardDiffFiles('project', [file], 'pkg/app/')
  useAppStore.getState().resolveConfirm(true)
  assert.equal(await result, true)
  assert.equal(useAppStore.getState().previewTarget, null)
})

test('routes images to the image viewer and preserves Windows paths', async () => {
  const workspace = useAppStore.getState().activeWorkspace!
  useAppStore.setState({ activeWorkspace: { ...workspace, path: 'C:\\project\\' } })
  await openDiffFile({ newPath: 'assets/image.png', isDeleted: false }, '')
  assert.equal(useAppStore.getState().previewTarget?.kind, 'image')
  assert.equal(useAppStore.getState().previewTarget?.path, 'C:\\project\\assets\\image.png')
})

test('declining the unsaved editor confirmation leaves the diff and preview untouched', async () => {
  useAppStore.setState({ editorDirty: true })
  const opening = openDiffFile({ newPath: 'other.ts', isDeleted: false }, '')
  const confirm = useAppStore.getState().confirmRequest
  assert.ok(confirm)
  useAppStore.getState().resolveConfirm(false)
  await opening
  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().currentView, 'diff')
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('discard sends only the filtered files after explicit confirmation', async () => {
  const files = [
    { oldPath: 'a.ts', newPath: 'a.ts', patch: 'patch-a' },
    { oldPath: 'b.ts', newPath: 'b.ts', patch: 'patch-b' },
  ]
  const filtered = filterSessionDiffFiles(files, [{
    id: 'msg', role: 'assistant', content: '', timestamp: 0,
    toolCalls: [{ id: 'call', name: 'edit', arguments: '{"path":"a.ts"}' }],
  }], '/project', '')
  const calls: unknown[] = []
  window.piDesktop.files.discardDiff = async (...args) => { calls.push(args) }
  const result = discardDiffFiles('project', filtered, '')
  assert.equal(calls.length, 0)
  assert.ok(useAppStore.getState().confirmRequest?.danger)
  // One file reads in the singular.
  assert.equal(useAppStore.getState().confirmRequest?.title, 'Discard shown change?')
  assert.match(useAppStore.getState().confirmRequest?.message ?? '', /in this file\?/)
  useAppStore.getState().resolveConfirm(true)
  assert.equal(await result, true)
  assert.deepEqual(calls, [['project', ['patch-a']]])
})

test('cancel or switching workspace while confirming never discards files', async () => {
  let invoked = false
  window.piDesktop.files.discardDiff = async () => { invoked = true }
  const file = { oldPath: 'a.ts', newPath: 'a.ts', patch: 'patch-a' }
  const canceled = discardDiffFiles('project', [file], '')
  useAppStore.getState().resolveConfirm(false)
  assert.equal(await canceled, false)
  const switched = discardDiffFiles('project', [file], '')
  useAppStore.setState({ activeWorkspace: { ...useAppStore.getState().activeWorkspace!, id: 'other' } })
  useAppStore.getState().resolveConfirm(true)
  assert.equal(await switched, false)
  assert.equal(invoked, false)
})

test('discard refuses unsaved editors and closes a clean affected preview after success', async () => {
  const file = { oldPath: 'a.ts', newPath: 'a.ts', patch: 'patch-a' }
  useAppStore.setState({ editorDirty: true })
  await assert.rejects(discardDiffFiles('project', [file], ''), /unsaved editor/)
  assert.equal(useAppStore.getState().confirmRequest, null)
  useAppStore.setState({ editorDirty: false, previewTarget: {
    kind: 'code', path: '/project/a.ts', relativePath: 'a.ts', name: 'a.ts',
  } })
  const result = discardDiffFiles('project', [file], '')
  useAppStore.getState().resolveConfirm(true)
  assert.equal(await result, true)
  assert.equal(useAppStore.getState().previewTarget, null)
})

test('discard failures propagate without closing the preview', async () => {
  const file = { oldPath: 'a.ts', newPath: 'a.ts', patch: 'patch-a' }
  const preview = { kind: 'code' as const, path: '/project/a.ts', relativePath: 'a.ts', name: 'a.ts' }
  useAppStore.setState({ previewTarget: preview })
  window.piDesktop.files.discardDiff = async () => { throw new Error('stale diff') }
  const result = discardDiffFiles('project', [file], '')
  useAppStore.getState().resolveConfirm(true)
  await assert.rejects(result, /stale diff/)
  assert.equal(useAppStore.getState().previewTarget, preview)
})

test('deleted files and missing workspaces do not open a preview', async () => {
  await openDiffFile({ newPath: 'deleted.ts', isDeleted: true }, '')
  assert.equal(useAppStore.getState().previewTarget, null)
  useAppStore.setState({ activeWorkspace: null })
  await openDiffFile({ newPath: 'file.ts', isDeleted: false }, '')
  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().currentView, 'diff')
})
