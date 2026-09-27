import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCommitPushShortcut, requestCommitPushDialog } from './commit-push-shortcut'
import { useAppStore } from '../store'
import { runAppShortcut } from './app-shortcuts'

const commandP = {
  key: 'p', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false,
}

test('commit and push requests only the modal without navigating or changing panels', async () => {
  for (const request of [requestCommitPushDialog, () => runAppShortcut('commitPush')]) {
    for (const currentView of ['chat', 'diff', 'settings', 'home'] as const) {
      useAppStore.setState({
        activeWorkspace: { id: 'project', name: 'Project', path: '/project', createdAt: 0, lastActiveAt: 0, color: '' },
        currentView,
        commitPushRequested: false,
      })
      const before = useAppStore.getState()
      await request()
      assert.deepEqual(useAppStore.getState(), { ...before, commitPushRequested: true })
    }
    useAppStore.setState({ activeWorkspace: null, commitPushRequested: false })
    const before = useAppStore.getState()
    await request()
    assert.equal(useAppStore.getState(), before)
  }
})

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
