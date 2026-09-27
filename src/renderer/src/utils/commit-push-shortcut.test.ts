import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCommitPushShortcut, requestCommitPushDialog } from './commit-push-shortcut'
import { useAppStore } from '../store'
import { runAppShortcut } from './app-shortcuts'

const commandP = {
  key: 'p', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false,
}

const workspace = { id: 'project', name: 'Project', path: '/project', createdAt: 0, lastActiveAt: 0, color: '' }

for (const [name, request] of [
  ['Command+P', requestCommitPushDialog],
  ['configured shortcut', () => runAppShortcut('commitPush')],
] as const) {
  test(`${name} opens filtered Diff first, then requests its Commit + Push button`, async () => {
    for (const currentView of ['chat', 'settings', 'home'] as const) {
      useAppStore.setState({
        activeWorkspace: workspace, currentView, chatSidePanel: null,
        editorDirty: false, workflowPanelOpen: false, diffShortcutRequest: null,
      })
      await request()
      assert.equal(useAppStore.getState().currentView, 'chat')
      assert.equal(useAppStore.getState().chatSidePanel, 'diff')
      assert.equal(useAppStore.getState().diffShortcutRequest, 'review')
      useAppStore.setState({ diffShortcutRequest: null })
      const before = useAppStore.getState()
      await request()
      assert.deepEqual(useAppStore.getState(), { ...before, diffShortcutRequest: 'commitPush' })
    }
  })

  test(`${name} uses the visible full Diff and does not commit through a hidden panel`, async () => {
    useAppStore.setState({ activeWorkspace: workspace, currentView: 'diff', workflowPanelOpen: false, diffShortcutRequest: null })
    const before = useAppStore.getState()
    await request()
    assert.deepEqual(useAppStore.getState(), { ...before, diffShortcutRequest: 'commitPush' })
    useAppStore.setState({ currentView: 'settings', chatSidePanel: 'diff', diffShortcutRequest: null })
    await request()
    assert.equal(useAppStore.getState().currentView, 'chat')
    assert.equal(useAppStore.getState().diffShortcutRequest, 'review')
  })

  test(`${name} respects cancelled editor guards and workspace changes`, async () => {
    const original = useAppStore.getState().setChatSidePanel
    try {
      for (const switchWorkspace of [false, true]) {
        useAppStore.setState({
          activeWorkspace: workspace, currentView: 'settings', chatSidePanel: null, diffShortcutRequest: null,
          setChatSidePanel: async () => {
            if (switchWorkspace) useAppStore.setState({ activeWorkspace: { ...workspace, id: 'other' } })
            return switchWorkspace
          },
        })
        await request()
        assert.equal(useAppStore.getState().currentView, 'settings')
        assert.equal(useAppStore.getState().diffShortcutRequest, null)
      }
    } finally {
      useAppStore.setState({ setChatSidePanel: original })
    }
    useAppStore.setState({ activeWorkspace: null, diffShortcutRequest: null })
    const before = useAppStore.getState()
    await request()
    assert.equal(useAppStore.getState(), before)
  })
}

test('Command+P opens commit and push, regardless of key casing', () => {
  assert.equal(isCommitPushShortcut(commandP), true)
  assert.equal(isCommitPushShortcut({ ...commandP, key: 'P' }), true)
})

test('leaves Ctrl+P, typing, modified shortcuts and IME composition untouched', () => {
  for (const override of [
    { metaKey: false, ctrlKey: true },
    { metaKey: false },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
    { key: 'k' },
  ]) {
    assert.equal(isCommitPushShortcut({ ...commandP, ...override }), false)
  }
})
