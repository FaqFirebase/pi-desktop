import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionRuntimeInfo } from '../../shared/ipc-contracts'

type StoreModule = typeof import('./store')
let useAppStore: StoreModule['useAppStore']
let selectActiveExtensionStatuses: StoreModule['selectActiveExtensionStatuses']

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    piDesktop: { session: { getStats: async () => null } },
  }
  ;({ useAppStore, selectActiveExtensionStatuses } = await import('./store'))
})

function runtime(runtimeId: string, extensionStatuses?: Record<string, string>, active = false): SessionRuntimeInfo {
  return {
    runtimeId,
    workspaceId: 'ws-1',
    sessionPath: null,
    sessionId: null,
    status: 'running',
    pid: 1,
    error: null,
    activity: null,
    active,
    ...(extensionStatuses ? { extensionStatuses } : {}),
  }
}

beforeEach(() => {
  useAppStore.setState({ activeSessionRuntimeId: null, sessionRuntimes: {} })
})

test('the chat on screen shows the statuses of its own runtime only', () => {
  const handle = useAppStore.getState().handleSessionRuntime
  handle(runtime('rt-2', { git: 'clean' }))
  assert.equal(selectActiveExtensionStatuses(useAppStore.getState()), undefined, 'no chat on screen, no statuses')

  handle(runtime('rt-1', { usage: '5h 35%' }, true))
  assert.deepEqual(selectActiveExtensionStatuses(useAppStore.getState()), { usage: '5h 35%' })

  // A background session's update does not reach the chat on screen.
  handle(runtime('rt-2', { git: 'dirty' }))
  assert.deepEqual(selectActiveExtensionStatuses(useAppStore.getState()), { usage: '5h 35%' })

  // Switching sessions shows the other runtime's latest statuses at once.
  handle(runtime('rt-1', { usage: '5h 35%' }))
  handle(runtime('rt-2', { git: 'dirty' }, true))
  assert.deepEqual(selectActiveExtensionStatuses(useAppStore.getState()), { git: 'dirty' })
})

test('a new snapshot replaces the statuses, and one without statuses clears them', () => {
  useAppStore.getState().handleSessionRuntime(runtime('rt-1', { usage: '5h 35%' }, true))
  useAppStore.getState().handleSessionRuntime(runtime('rt-1', { usage: '5h 36%' }, true))
  assert.deepEqual(selectActiveExtensionStatuses(useAppStore.getState()), { usage: '5h 36%' })
  useAppStore.getState().handleSessionRuntime(runtime('rt-1', undefined, true))
  assert.equal(selectActiveExtensionStatuses(useAppStore.getState()), undefined)
})

test('a streamed setStatus request leaves the store alone; main publishes the snapshot', () => {
  useAppStore.getState().handleSessionRuntime(runtime('rt-1', { usage: '5h 35%' }, true))
  const before = useAppStore.getState().sessionRuntimes
  useAppStore.getState().handlePiEvent({
    type: 'extension_ui_request', id: 's1', method: 'setStatus', statusKey: 'usage', statusText: 'stale',
  })
  assert.equal(useAppStore.getState().sessionRuntimes, before)
  assert.deepEqual(selectActiveExtensionStatuses(useAppStore.getState()), { usage: '5h 35%' })
})
