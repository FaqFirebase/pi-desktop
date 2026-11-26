import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'path'
import { createSessionUnreadTracker, type SessionUnreadTracker } from './session-unread'
import type { SessionTimestampMap } from './session-timestamp-store'
import type { WorkspaceActivityNotification } from './workspace-activity'

const PATH_A = join('root', 'proj', 'a.jsonl')
const PATH_B = join('root', 'proj', 'b.jsonl')
const WORKSPACE_ID = 'ws-1'
const MARK_TIME = 1
const RUNTIME_ID = 'rt-1'

interface Harness {
  tracker: SessionUnreadTracker
  changes: SessionTimestampMap[]
  setFocused(focused: boolean): void
}

function createHarness(): Harness {
  const entries = new Map<string, number>()
  let focused = true
  const changes: SessionTimestampMap[] = []
  const tracker = createSessionUnreadTracker({
    store: {
      add: async (sessionId) => {
        if (entries.has(sessionId)) return false
        entries.set(sessionId, MARK_TIME)
        return true
      },
      remove: async (sessionId) => entries.delete(sessionId),
      getAll: async () => Object.fromEntries(entries),
    },
    isMainWindowFocused: () => focused,
    onChange: (map) => changes.push(map),
  })
  return { tracker, changes, setFocused: (next) => { focused = next } }
}

function turnEnd(sessionPath: string, kind: WorkspaceActivityNotification['kind'] = 'completed'): WorkspaceActivityNotification {
  return { workspaceId: WORKSPACE_ID, kind, sessionPath }
}

async function unreadIds(tracker: SessionUnreadTracker): Promise<string[]> {
  return Object.keys(await tracker.getAll()).sort()
}

test('turn end in a hidden session marks it unread', async () => {
  const { tracker, changes } = createHarness()
  await tracker.setVisibleSession(PATH_B)
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  assert.deepEqual(await unreadIds(tracker), ['a'])
  assert.equal(changes.length, 1)
})

test('turn end in the visible focused session does not mark it', async () => {
  const { tracker, changes } = createHarness()
  await tracker.setVisibleSession(PATH_A)
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  assert.deepEqual(await tracker.getAll(), {})
  assert.equal(changes.length, 0)
})

test('turn end in the visible session while unfocused marks it unread', async () => {
  const { tracker, setFocused } = createHarness()
  await tracker.setVisibleSession(PATH_A)
  setFocused(false)
  await tracker.handleActivityNotification(turnEnd(PATH_A, 'failed'))
  assert.deepEqual(await unreadIds(tracker), ['a'])
})

test('needs-approval and pathless notifications without a runtime are ignored', async () => {
  const { tracker } = createHarness()
  await tracker.handleActivityNotification(turnEnd(PATH_A, 'needs-approval'))
  await tracker.handleActivityNotification({ workspaceId: WORKSPACE_ID, kind: 'completed' })
  assert.deepEqual(await tracker.getAll(), {})
})

test('a second turn end does not broadcast again', async () => {
  const { tracker, changes } = createHarness()
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  assert.equal(changes.length, 1)
})

test('showing the session while focused clears it', async () => {
  const { tracker, changes } = createHarness()
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  await tracker.setVisibleSession(PATH_A)
  assert.deepEqual(await tracker.getAll(), {})
  assert.deepEqual(changes.at(-1), {})
})

test('showing the session while unfocused keeps it', async () => {
  const { tracker, setFocused } = createHarness()
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  setFocused(false)
  await tracker.setVisibleSession(PATH_A)
  assert.deepEqual(await unreadIds(tracker), ['a'])
})

test('focus clears the visible session only', async () => {
  const { tracker, setFocused } = createHarness()
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  await tracker.handleActivityNotification(turnEnd(PATH_B))
  setFocused(false)
  await tracker.setVisibleSession(PATH_A)
  setFocused(true)
  await tracker.handleMainWindowFocus()
  assert.deepEqual(await unreadIds(tracker), ['b'])
})

test('setVisibleSession(null) means nothing is on screen', async () => {
  const { tracker } = createHarness()
  await tracker.setVisibleSession(null)
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  assert.deepEqual(await unreadIds(tracker), ['a'])
})

test('forget removes an unread entry and broadcasts once', async () => {
  const { tracker, changes } = createHarness()
  await tracker.handleActivityNotification(turnEnd(PATH_A))
  const changesBefore = changes.length
  await tracker.forget('a')
  await tracker.forget('a')
  assert.deepEqual(await tracker.getAll(), {})
  assert.equal(changes.length - changesBefore, 1)
})

test('a turn end before the runtime reports its file marks the session once the file is known', async () => {
  const { tracker, changes } = createHarness()
  await tracker.handleActivityNotification({ workspaceId: WORKSPACE_ID, kind: 'completed', runtimeId: RUNTIME_ID })
  assert.deepEqual(await tracker.getAll(), {})
  await tracker.handleRuntimeSession({ runtimeId: RUNTIME_ID, sessionPath: PATH_A })
  assert.deepEqual(await unreadIds(tracker), ['a'])
  await tracker.handleRuntimeSession({ runtimeId: RUNTIME_ID, sessionPath: PATH_A })
  assert.equal(changes.length, 1)
})

test('a runtime that reports its file with no turn end waiting is not marked', async () => {
  const { tracker } = createHarness()
  await tracker.handleRuntimeSession({ runtimeId: RUNTIME_ID, sessionPath: PATH_A })
  assert.deepEqual(await tracker.getAll(), {})
})

test('a closed runtime drops its waiting turn end', async () => {
  const { tracker } = createHarness()
  await tracker.handleActivityNotification({ workspaceId: WORKSPACE_ID, kind: 'completed', runtimeId: RUNTIME_ID })
  await tracker.handleRuntimeSession({ runtimeId: RUNTIME_ID, sessionPath: null, closed: true })
  await tracker.handleRuntimeSession({ runtimeId: RUNTIME_ID, sessionPath: PATH_A })
  assert.deepEqual(await tracker.getAll(), {})
})
