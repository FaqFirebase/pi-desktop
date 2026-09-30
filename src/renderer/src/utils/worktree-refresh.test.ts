import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKTREE_DISK_CHANGE_DEBOUNCE_MS, subscribeWorktreeRefresh } from './worktree-refresh'

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { piDesktop: {} } })
})

test('refreshes a worktree view at agent end and after a branch switch, and unsubscribes when closed', () => {
  let agentListener: Parameters<typeof window.piDesktop.onEvent>[0] | undefined
  let fileListener: Parameters<typeof window.piDesktop.onFileChange>[0] | undefined
  window.piDesktop.onEvent = (callback) => {
    agentListener = callback
    return () => { agentListener = undefined }
  }
  window.piDesktop.onFileChange = (callback) => {
    fileListener = callback
    return () => { fileListener = undefined }
  }
  let refreshes = 0
  const close = subscribeWorktreeRefresh(async () => { refreshes++ }, false)
  agentListener?.({ type: 'agent_start' })
  agentListener?.({ type: 'turn_start' })
  fileListener?.({ changeType: 'change', relativePath: 'app.ts' })
  assert.equal(refreshes, 0)
  agentListener?.({ type: 'agent_end', messages: [] })
  assert.equal(refreshes, 1)
  fileListener?.({ changeType: 'change', relativePath: '.' })
  assert.equal(refreshes, 2)
  close()
  assert.equal(agentListener, undefined)
  assert.equal(fileListener, undefined)
})

test('a visible worktree view reloads once after a burst of disk edits settles, and never while hidden', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let fileListener: Parameters<typeof window.piDesktop.onFileChange>[0] | undefined
  window.piDesktop.onEvent = () => () => {}
  window.piDesktop.onFileChange = (callback) => {
    fileListener = callback
    return () => { fileListener = undefined }
  }
  let refreshes = 0
  const refresh = async (): Promise<void> => { refreshes++ }

  const closeHidden = subscribeWorktreeRefresh(refresh, false)
  fileListener?.({ changeType: 'change', relativePath: 'app.ts' })
  t.mock.timers.tick(WORKTREE_DISK_CHANGE_DEBOUNCE_MS)
  assert.equal(refreshes, 0)
  closeHidden()

  const closeVisible = subscribeWorktreeRefresh(refresh, true)
  fileListener?.({ changeType: 'change', relativePath: 'app.ts' })
  t.mock.timers.tick(WORKTREE_DISK_CHANGE_DEBOUNCE_MS - 1)
  fileListener?.({ changeType: 'add', relativePath: 'new.ts' })
  t.mock.timers.tick(WORKTREE_DISK_CHANGE_DEBOUNCE_MS - 1)
  assert.equal(refreshes, 0)
  t.mock.timers.tick(1)
  assert.equal(refreshes, 1)

  // Closing drops a pending reload.
  fileListener?.({ changeType: 'change', relativePath: 'app.ts' })
  closeVisible()
  t.mock.timers.tick(WORKTREE_DISK_CHANGE_DEBOUNCE_MS)
  assert.equal(refreshes, 1)
})
