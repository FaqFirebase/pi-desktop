import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { useAppStore } from '../store'
import { diffCommitSelection, discardDiffFiles, openDiffFile, parseDiff } from './diff-viewer'
import { hasCommittableChanges } from './git-conveyor-actions'
import { filterSessionDiffFiles } from '../utils/session-diff'
import type { GitDiffPaths } from '../../../shared/git-diff'

/** Both sides of a patch that names one file. */
function samePaths(path: string): GitDiffPaths {
  return { oldPath: path, newPath: path }
}

/** A shown file the way the diff list builds it. */
function diffFile(path: string, patch: string) {
  return { paths: samePaths(path), label: path, patch }
}

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

/** `git diff` output for a name with a space, one Git quotes, and one that is not UTF-8 (Latin-1 bytes). */
const WORKING_DIFF = [
  'diff --git a/Meeting notes.md b/Meeting notes.md', 'index 5626abf..f719efd 100644',
  '--- a/Meeting notes.md\t', '+++ b/Meeting notes.md\t', '@@ -1 +1,2 @@', ' one', '+two',
  'diff --git "a/gr\\303\\274\\303\\237e.txt" "b/gr\\303\\274\\303\\237e.txt"', 'index 5626abf..f719efd 100644',
  '--- "a/gr\\303\\274\\303\\237e.txt"', '+++ "b/gr\\303\\274\\303\\237e.txt"', '@@ -1 +1,2 @@', ' one', '+two',
  'diff --git "a/caf\\351.txt" "b/caf\\351.txt"', 'index 5626abf..f719efd 100644',
  '--- "a/caf\\351.txt"', '+++ "b/caf\\351.txt"', '@@ -1 +1,2 @@', ' one', '+two',
  '',
].join('\n')

test('the diff list reads every name Git quotes, and never invents a path for one it cannot read', () => {
  const files = parseDiff(WORKING_DIFF)
  assert.deepEqual(files.map((file) => [file.label, file.paths]), [
    ['Meeting notes.md', { oldPath: 'Meeting notes.md', newPath: 'Meeting notes.md' }],
    ['grüße.txt', { oldPath: 'grüße.txt', newPath: 'grüße.txt' }],
    ['"a/caf\\351.txt" "b/caf\\351.txt"', null],
  ])
  assert.deepEqual(diffCommitSelection(files), { files: 3, paths: ['Meeting notes.md', 'grüße.txt'] })
  // The status keys of `git status -z` are the same raw paths, so Commit is offered.
  const status = { 'Meeting notes.md': { index: ' ', worktree: 'M', isStaged: false } }
  assert.equal(hasCommittableChanges(status, diffCommitSelection(files.slice(0, 1))), true)
})

test('opens the exact diff path and reveals the editor from either diff surface', async () => {
  await openDiffFile({ paths: samePaths('src/new name.ts'), isDeleted: false }, '')
  const state = useAppStore.getState()
  assert.deepEqual(state.previewTarget, {
    kind: 'code', name: 'new name.ts', path: '/project/src/new name.ts', relativePath: 'src/new name.ts',
  })
  assert.equal(state.currentView, 'chat')
  assert.equal(state.chatSidePanel, null)
})

test('opens monorepo diff paths relative to the workspace and skips files outside it', async () => {
  useAppStore.setState({ activeWorkspace: { ...useAppStore.getState().activeWorkspace!, path: '/repo/pkg/app' } })
  await openDiffFile({ paths: samePaths('root.ts'), isDeleted: false }, 'pkg/app/')
  assert.equal(useAppStore.getState().previewTarget, null)
  await openDiffFile({ paths: samePaths('pkg/app2/a.ts'), isDeleted: false }, 'pkg/app/')
  assert.equal(useAppStore.getState().previewTarget, null)
  await openDiffFile({ paths: samePaths('pkg/app/src/a.ts'), isDeleted: false }, 'pkg/app/')
  assert.deepEqual(useAppStore.getState().previewTarget, {
    kind: 'code', name: 'a.ts', path: '/repo/pkg/app/src/a.ts', relativePath: 'src/a.ts',
  })
})

test('discard closes a monorepo preview opened by its workspace-relative path', async () => {
  const file = diffFile('pkg/app/a.ts', 'patch-a')
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
  await openDiffFile({ paths: samePaths('assets/image.png'), isDeleted: false }, '')
  assert.equal(useAppStore.getState().previewTarget?.kind, 'image')
  assert.equal(useAppStore.getState().previewTarget?.path, 'C:\\project\\assets\\image.png')
})

test('declining the unsaved editor confirmation leaves the diff and preview untouched', async () => {
  useAppStore.setState({ editorDirty: true })
  const opening = openDiffFile({ paths: samePaths('other.ts'), isDeleted: false }, '')
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
    diffFile('a.ts', 'patch-a'),
    diffFile('b.ts', 'patch-b'),
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
  const file = diffFile('a.ts', 'patch-a')
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
  const file = diffFile('a.ts', 'patch-a')
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
  const file = diffFile('a.ts', 'patch-a')
  const preview = { kind: 'code' as const, path: '/project/a.ts', relativePath: 'a.ts', name: 'a.ts' }
  useAppStore.setState({ previewTarget: preview })
  window.piDesktop.files.discardDiff = async () => { throw new Error('stale diff') }
  const result = discardDiffFiles('project', [file], '')
  useAppStore.getState().resolveConfirm(true)
  await assert.rejects(result, /stale diff/)
  assert.equal(useAppStore.getState().previewTarget, preview)
})

test('deleted files and missing workspaces do not open a preview', async () => {
  await openDiffFile({ paths: samePaths('deleted.ts'), isDeleted: true }, '')
  assert.equal(useAppStore.getState().previewTarget, null)
  useAppStore.setState({ activeWorkspace: null })
  await openDiffFile({ paths: samePaths('file.ts'), isDeleted: false }, '')
  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().currentView, 'diff')
})
