import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createWorkspaceActivityTracker,
  type WorkspaceActivityNotification,
  type WorkspaceActivityTracker,
} from './workspace-activity'
import type { WorkspaceActivityMap } from '../shared/ipc-contracts'

interface Harness {
  tracker: WorkspaceActivityTracker
  changes: WorkspaceActivityMap[]
  notifications: WorkspaceActivityNotification[]
  setActive(id: string | null): void
  advance(ms: number): void
}

function makeHarness(activeId: string | null = 'ws-active'): Harness {
  let active = activeId
  let clock = 1000
  const changes: WorkspaceActivityMap[] = []
  const notifications: WorkspaceActivityNotification[] = []
  const tracker = createWorkspaceActivityTracker({
    getActiveWorkspaceId: () => active,
    now: () => clock,
    onChange: (map) => changes.push(map),
    onNotify: (notification) => notifications.push(notification),
  })
  return {
    tracker,
    changes,
    notifications,
    setActive: (id) => {
      active = id
    },
    advance: (ms) => {
      clock += ms
    },
  }
}

function lastMap(h: Harness): WorkspaceActivityMap {
  assert.ok(h.changes.length > 0, 'expected at least one onChange emission')
  return h.changes[h.changes.length - 1]
}

test('agent_start marks a workspace working without notifying', () => {
  const h = makeHarness()
  h.tracker.handleAgentStart('ws-bg')
  assert.equal(lastMap(h)['ws-bg'].state, 'working')
  assert.equal(h.notifications.length, 0)
})

test('agent_end in the active workspace leaves no map marker but still notifies', () => {
  // The map's dot is for background workspaces, but the notification also
  // covers "active workspace finished while the window is unfocused" — the
  // focus decision belongs to shouldNotify, not the tracker.
  const h = makeHarness('ws-active')
  h.tracker.handleAgentStart('ws-active')
  h.tracker.handleAgentEnd('ws-active')
  assert.deepEqual(lastMap(h), {})
  assert.deepEqual(h.notifications, [{ workspaceId: 'ws-active', kind: 'completed' }])
})

test('agent_end without a running turn does not notify', () => {
  const h = makeHarness('ws-active')
  h.tracker.handleAgentEnd('ws-bg')
  assert.equal(h.notifications.length, 0)
})

test('agent_end in a background workspace marks completed and notifies', () => {
  const h = makeHarness('ws-active')
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleAgentEnd('ws-bg')
  assert.equal(lastMap(h)['ws-bg'].state, 'completed')
  assert.deepEqual(h.notifications, [{ workspaceId: 'ws-bg', kind: 'completed' }])
})

test('agent_end preserves the exact runtime session target for notification clicks', () => {
  const h = makeHarness('ws-active')
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleAgentEnd('ws-bg', { runtimeId: 'rt-1', sessionPath: '/sessions/finished.jsonl' })
  assert.deepEqual(h.notifications, [{
    workspaceId: 'ws-bg',
    kind: 'completed',
    runtimeId: 'rt-1',
    sessionPath: '/sessions/finished.jsonl',
  }])
})

test('pending prompts override working and notify needs-approval', () => {
  const h = makeHarness('ws-active')
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handlePendingCounts({ 'ws-bg': 2 })
  assert.equal(lastMap(h)['ws-bg'].state, 'needs-approval')
  assert.deepEqual(h.notifications, [{ workspaceId: 'ws-bg', kind: 'needs-approval' }])

  // Answering the prompt returns to working without another notification.
  h.tracker.handlePendingCounts({})
  assert.equal(lastMap(h)['ws-bg'].state, 'working')
  assert.equal(h.notifications.length, 1)
})

test('a count moving between positive values does not re-notify', () => {
  const h = makeHarness()
  h.tracker.handlePendingCounts({ 'ws-bg': 1 })
  h.tracker.handlePendingCounts({ 'ws-bg': 3 })
  assert.deepEqual(h.notifications, [{ workspaceId: 'ws-bg', kind: 'needs-approval' }])
})

test('process error marks failed and notifies', () => {
  const h = makeHarness()
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleStatusChange('ws-bg', 'error')
  assert.equal(lastMap(h)['ws-bg'].state, 'failed')
  assert.deepEqual(h.notifications, [{ workspaceId: 'ws-bg', kind: 'failed' }])
})

test('an error in the active workspace notifies without a map marker', () => {
  const h = makeHarness('ws-active')
  h.tracker.handleAgentStart('ws-active')
  h.tracker.handleStatusChange('ws-active', 'error')
  assert.deepEqual(h.tracker.getMap(), {})
  assert.deepEqual(h.notifications, [{ workspaceId: 'ws-active', kind: 'failed' }])
})

test('a deliberate stop mid-turn is NOT a failure (quit, stop, folder change)', () => {
  // stop() detaches listeners before killing, so no 'exit' follows — the
  // sequence a deliberate stop produces is status 'stopped' alone.
  const h = makeHarness()
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleStatusChange('ws-bg', 'stopped')
  assert.deepEqual(lastMap(h), {})
  assert.equal(h.notifications.length, 0)
})

test('a crash mid-turn (stopped then exit) is a failure', () => {
  // A real crash emits status-change 'stopped' first, THEN 'exit'.
  const h = makeHarness()
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleStatusChange('ws-bg', 'stopped')
  h.tracker.handleProcessExit('ws-bg')
  assert.equal(lastMap(h)['ws-bg'].state, 'failed')
  assert.deepEqual(h.notifications, [{ workspaceId: 'ws-bg', kind: 'failed' }])
})

test('a crash while idle neither marks nor notifies', () => {
  const h = makeHarness()
  h.tracker.handleStatusChange('ws-bg', 'stopped')
  h.tracker.handleProcessExit('ws-bg')
  assert.equal(h.changes.length, 0)
  assert.equal(h.notifications.length, 0)
})

test('a restart between stop and exit clears the mid-turn marker', () => {
  const h = makeHarness()
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleStatusChange('ws-bg', 'stopped')
  h.tracker.handleStatusChange('ws-bg', 'running')
  h.tracker.handleProcessExit('ws-bg')
  assert.equal(h.notifications.length, 0)
})

test('a fresh running process clears a stale failure', () => {
  const h = makeHarness()
  h.tracker.handleStatusChange('ws-bg', 'error')
  assert.equal(lastMap(h)['ws-bg'].state, 'failed')
  h.tracker.handleStatusChange('ws-bg', 'running')
  assert.deepEqual(lastMap(h), {})
})

test('seeing a workspace clears completed but not an in-flight turn', () => {
  const h = makeHarness('ws-active')
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleAgentEnd('ws-bg')
  h.tracker.handleWorkspaceSeen('ws-bg')
  assert.deepEqual(lastMap(h), {})

  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleWorkspaceSeen('ws-bg')
  assert.equal(h.tracker.getMap()['ws-bg'].state, 'working')
})

test('removing a workspace drops its entry', () => {
  const h = makeHarness()
  h.tracker.handleAgentStart('ws-bg')
  h.tracker.handleWorkspaceRemoved('ws-bg')
  assert.deepEqual(lastMap(h), {})
  h.tracker.handleAgentEnd('ws-bg')
  // Signals were dropped too: the late agent_end re-derives from scratch.
  assert.equal(h.tracker.getMap()['ws-bg']?.state, 'completed')
})

test('since is stamped on state entry and stable across repeated inputs', () => {
  const h = makeHarness('ws-active')
  h.tracker.handleAgentStart('ws-bg')
  const started = lastMap(h)['ws-bg'].since
  h.advance(500)
  h.tracker.handleAgentStart('ws-bg')
  assert.equal(h.tracker.getMap()['ws-bg'].since, started)

  h.advance(500)
  h.tracker.handleAgentEnd('ws-bg')
  assert.equal(lastMap(h)['ws-bg'].since, started + 1000)
})

test('onChange fires only when derived state actually changes', () => {
  const h = makeHarness()
  h.tracker.handlePendingCounts({})
  h.tracker.handleStatusChange('ws-bg', 'starting')
  assert.equal(h.changes.length, 0)

  h.tracker.handleAgentStart('ws-bg')
  assert.equal(h.changes.length, 1)
  h.tracker.handlePendingCounts({})
  assert.equal(h.changes.length, 1)
})
