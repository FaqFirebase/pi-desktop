import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { useAppStore } from './store'
import type { SessionListItem } from '../../shared/ipc-contracts'

const initialState = useAppStore.getState()
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const SESSION_ID = 'a'
const PIN_TIME = 5
const ARCHIVE_TIME = 9
const UNREAD_TIME = 7
const SESSION: SessionListItem = {
  path: '/sessions/proj/a.jsonl',
  name: null,
  preview: null,
  sessionId: SESSION_ID,
  lastModified: 1,
  messageCount: 0,
  projectPath: '/proj',
  projectName: 'proj',
}

function stubSessionBridge(session: Record<string, unknown>): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { piDesktop: {
    ui: { setEditorDirty: () => {} },
    session,
  } } })
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('pinSession stores the map main returns', async () => {
  stubSessionBridge({ pin: async () => ({ [SESSION_ID]: PIN_TIME }) })
  await useAppStore.getState().pinSession(SESSION_ID)
  assert.deepEqual(useAppStore.getState().pinnedSessions, { [SESSION_ID]: PIN_TIME })
})

test('archiveSession drops the pin locally', async () => {
  stubSessionBridge({ archive: async () => ({ [SESSION_ID]: ARCHIVE_TIME }) })
  useAppStore.setState({ pinnedSessions: { [SESSION_ID]: PIN_TIME } })
  await useAppStore.getState().archiveSession(SESSION_ID)
  assert.deepEqual(useAppStore.getState().pinnedSessions, {})
  assert.deepEqual(useAppStore.getState().archivedSessions, { [SESSION_ID]: ARCHIVE_TIME })
})

test('deleteSession drops the pin locally', async () => {
  stubSessionBridge({
    delete: async () => ({ ok: true, method: 'trash' }),
    list: async () => [],
  })
  useAppStore.setState({ pinnedSessions: { [SESSION_ID]: PIN_TIME } })
  await useAppStore.getState().deleteSession(SESSION)
  assert.deepEqual(useAppStore.getState().pinnedSessions, {})
})

test('handleUnreadSessions replaces the map', () => {
  useAppStore.setState({ unreadSessions: { old: UNREAD_TIME } })
  useAppStore.getState().handleUnreadSessions({ [SESSION_ID]: UNREAD_TIME })
  assert.deepEqual(useAppStore.getState().unreadSessions, { [SESSION_ID]: UNREAD_TIME })
})
