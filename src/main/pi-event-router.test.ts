import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PiRpcManager } from './pi-rpc-manager'
import { createPiEventRouter, type PiEventRouter } from './pi-event-router'
import type { PendingPromptCounts, PiExtensionUiRequest, PiRpcEvent } from '../shared/ipc-contracts'

const WS_A = 'ws-a'
const WS_B = 'ws-b'
const PROMPT_TIMEOUT_MS = 5_000

/**
 * Pi holds the tool call for every one of these methods, so each must queue
 * rather than drop when its workspace is inactive; narrowing the router's set
 * to a subset would deadlock the other methods' turns.
 */
const BLOCKING_METHODS: readonly PiExtensionUiRequest['method'][] = ['select', 'confirm', 'input', 'editor']

function dialogRequest(id: string, overrides: Partial<PiExtensionUiRequest> = {}): PiExtensionUiRequest {
  return {
    type: 'extension_ui_request',
    id,
    method: 'confirm',
    title: `Approve ${id}?`,
    ...overrides,
  }
}

function notifyRequest(id: string): PiExtensionUiRequest {
  return { type: 'extension_ui_request', id, method: 'notify', message: 'done' }
}

interface RecordedResponse {
  workspaceId: string
  id: string
  response: Record<string, unknown>
}

interface Harness {
  router: PiEventRouter
  managers: Map<string, PiRpcManager>
  broadcasts: PiRpcEvent[]
  countsLog: PendingPromptCounts[]
  responses: RecordedResponse[]
  clock: { now: number }
  setActive(workspaceId: string | null): void
  addManager(workspaceId: string): PiRpcManager
}

/**
 * Drives the router with real PiRpcManager instances used as bare emitters (no
 * child process is ever spawned). Responses are recorded per workspace by
 * overriding sendExtensionUiResponse, which would otherwise no-op silently
 * because the managers are not running.
 */
function createHarness(workspaceIds: string[], activeId: string | null = workspaceIds[0] ?? null): Harness {
  const managers = new Map<string, PiRpcManager>()
  const broadcasts: PiRpcEvent[] = []
  const countsLog: PendingPromptCounts[] = []
  const responses: RecordedResponse[] = []
  const clock = { now: 0 }
  let active = activeId

  const router = createPiEventRouter({
    getActiveManager: () => (active !== null ? (managers.get(active) ?? null) : null),
    workspaceIdFor: (manager) => {
      for (const [workspaceId, candidate] of managers) {
        if (candidate === manager) return workspaceId
      }
      return null
    },
    broadcastEvent: (event) => broadcasts.push(event),
    broadcastPendingCounts: (counts) => countsLog.push(counts),
    now: () => clock.now,
  })

  const addManager = (workspaceId: string): PiRpcManager => {
    const manager = new PiRpcManager()
    manager.sendExtensionUiResponse = (id, response): void => {
      responses.push({ workspaceId, id, response })
    }
    managers.set(workspaceId, manager)
    router.attachManager(manager)
    return manager
  }
  for (const workspaceId of workspaceIds) addManager(workspaceId)

  return {
    router,
    managers,
    broadcasts,
    countsLog,
    responses,
    clock,
    setActive: (workspaceId) => {
      active = workspaceId
    },
    addManager,
  }
}

// ─── Passthrough filter ──────────────────────────────────────────────────────

test('non-dialog events pass through from the active manager only', () => {
  const h = createHarness([WS_A, WS_B])
  const activeTurn: PiRpcEvent = { type: 'turn_start' }
  h.managers.get(WS_A)!.emit('event', activeTurn)
  h.managers.get(WS_B)!.emit('event', { type: 'turn_start' })
  h.managers.get(WS_B)!.emit('event', notifyRequest('n1'))
  h.managers.get(WS_B)!.emit('status-change', 'running')
  assert.deepEqual(h.broadcasts, [activeTurn], 'inactive traffic must stay filtered out')
  assert.deepEqual(h.countsLog, [], 'non-dialog traffic must not touch pending counts')
})

test('notify from the active manager passes through without queueing', () => {
  const h = createHarness([WS_A])
  const notify = notifyRequest('n1')
  h.managers.get(WS_A)!.emit('event', notify)
  assert.deepEqual(h.broadcasts, [notify])
  assert.deepEqual(h.router.getPendingCounts(), {})
})

test('active manager status changes broadcast as status_change events', () => {
  const h = createHarness([WS_A])
  h.managers.get(WS_A)!.emit('status-change', 'running')
  // The payload comes from getStatus(); a never-started manager reports 'stopped'.
  assert.deepEqual(h.broadcasts, [
    { type: 'status_change', status: 'stopped', pid: null, error: null, engine: 'pi', startupPhase: undefined },
  ])
})

// ─── Queueing and delivery ───────────────────────────────────────────────────

for (const method of BLOCKING_METHODS) {
  test(`a ${method} dialog from an inactive workspace is queued, not dropped`, () => {
    const h = createHarness([WS_A, WS_B])
    h.managers.get(WS_B)!.emit('event', dialogRequest('b1', { method }))
    assert.deepEqual(h.broadcasts, [], 'an inactive dialog must not reach the renderer yet')
    assert.deepEqual(h.router.getPendingCounts(), { [WS_B]: 1 })
    h.router.respond('b1', { value: 'answer' })
    assert.deepEqual(
      h.responses,
      [{ workspaceId: WS_B, id: 'b1', response: { value: 'answer' } }],
      'the answer must reach the Pi that asked, not the active one'
    )
    assert.deepEqual(h.countsLog, [{ [WS_B]: 1 }, {}])
    assert.deepEqual(h.router.getPendingCounts(), {})
  })

  test(`${method} dialogs from the active workspace deliver immediately and serialize`, () => {
    const h = createHarness([WS_A, WS_B])
    const first = dialogRequest('a1', { method })
    const second = dialogRequest('a2', { method })
    h.managers.get(WS_A)!.emit('event', first)
    h.managers.get(WS_A)!.emit('event', second)
    assert.deepEqual(h.broadcasts, [first], 'the second dialog must wait for the first answer')
    assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 2 })
    h.router.respond('a1', { value: 'answer' })
    assert.deepEqual(h.responses, [{ workspaceId: WS_A, id: 'a1', response: { value: 'answer' } }])
    assert.deepEqual(h.broadcasts, [first, second], 'answering the delivered dialog chains the queued one')
    assert.deepEqual(h.countsLog, [{ [WS_A]: 1 }, { [WS_A]: 2 }, { [WS_A]: 1 }])
    assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 1 })
  })
}

// ─── Responding ──────────────────────────────────────────────────────────────

test('answering a dialog whose workspace is no longer active does not chain the next one', () => {
  const h = createHarness([WS_A, WS_B])
  const first = dialogRequest('a1')
  const second = dialogRequest('a2')
  h.managers.get(WS_A)!.emit('event', first)
  h.managers.get(WS_A)!.emit('event', second)
  h.setActive(WS_B)
  h.router.handleActiveWorkspaceChanged()
  h.router.respond('a1', { confirmed: true })
  assert.deepEqual(h.broadcasts, [first], 'the queued dialog must wait for the switch back')
  assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 1 }, 'the held dialog stays counted')
  assert.deepEqual(h.countsLog.at(-1), { [WS_A]: 1 })
  h.setActive(WS_A)
  h.router.flush(WS_A)
  assert.deepEqual(h.broadcasts, [first, second], 'switching back delivers the held dialog')
})

test('respond with an unknown id falls back to the active manager', () => {
  const h = createHarness([WS_A])
  h.router.respond('ghost', { value: '' })
  assert.deepEqual(h.responses, [{ workspaceId: WS_A, id: 'ghost', response: { value: '' } }])
})

test('respond with no origin and no active manager drops silently', () => {
  const h = createHarness([WS_A], null)
  h.router.respond('ghost', { value: '' })
  assert.deepEqual(h.responses, [])
})

test('respond purges a queued, undelivered copy of the same id', () => {
  const h = createHarness([WS_A])
  const first = dialogRequest('a1')
  const second = dialogRequest('a2')
  h.managers.get(WS_A)!.emit('event', first)
  h.managers.get(WS_A)!.emit('event', second)
  h.router.respond('a2', { confirmed: true })
  assert.deepEqual(h.responses.map((r) => r.id), ['a2'])
  assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 1 }, 'only the still-delivered first dialog remains')
  h.router.respond('a1', { confirmed: true })
  assert.deepEqual(h.broadcasts, [first], 'the answered-while-queued dialog must never be delivered')
  assert.deepEqual(h.router.getPendingCounts(), {})
})

// ─── Flush (self-healing re-broadcast) ───────────────────────────────────────

test('flush re-broadcasts the retained delivered dialog for the active workspace', () => {
  const h = createHarness([WS_A])
  const request = dialogRequest('a1')
  h.managers.get(WS_A)!.emit('event', request)
  h.router.flush(WS_A)
  assert.deepEqual(h.broadcasts, [request, request])
  assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 1 }, 'a re-broadcast must not duplicate state')
  assert.deepEqual(h.countsLog, [{ [WS_A]: 1 }], 'replaying the same dialog changes no count')
})

test('flush for a non-active workspace is a no-op', () => {
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  h.router.flush(WS_B)
  assert.deepEqual(h.broadcasts, [])
  assert.deepEqual(h.router.getPendingCounts(), { [WS_B]: 1 })
})

test('flush after switching to a workspace delivers its queued dialog', () => {
  const h = createHarness([WS_A, WS_B])
  const request = dialogRequest('b1')
  h.managers.get(WS_B)!.emit('event', request)
  h.setActive(WS_B)
  h.router.handleActiveWorkspaceChanged()
  const countsBeforeFlush = h.countsLog.length
  h.router.flush(WS_B)
  assert.deepEqual(h.broadcasts, [request])
  assert.deepEqual(h.router.getPendingCounts(), { [WS_B]: 1 })
  assert.equal(h.countsLog.length, countsBeforeFlush + 1, 'promoting a queued dialog must re-broadcast counts')
  assert.deepEqual(h.countsLog.at(-1), { [WS_B]: 1 })
})

// ─── Eviction ────────────────────────────────────────────────────────────────

test('a manager leaving the running state evicts its held prompts', () => {
  const h = createHarness([WS_A, WS_B])
  const firstA = dialogRequest('a1')
  h.managers.get(WS_A)!.emit('event', firstA)
  h.managers.get(WS_A)!.emit('event', dialogRequest('a2'))
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  h.managers.get(WS_A)!.emit('status-change', 'stopped')
  assert.deepEqual(h.router.getPendingCounts(), { [WS_B]: 1 })
  assert.deepEqual(h.countsLog.at(-1), { [WS_B]: 1 })
  h.router.flush(WS_A)
  assert.deepEqual(
    h.broadcasts.filter((e) => e.type === 'extension_ui_request'),
    [firstA],
    'evicted prompts must not resurface'
  )
})

test('an error status evicts held prompts', () => {
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  h.managers.get(WS_B)!.emit('status-change', 'error')
  assert.deepEqual(h.router.getPendingCounts(), {})
  assert.deepEqual(h.countsLog.at(-1), {})
})

test('process exit evicts held prompts', () => {
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  h.managers.get(WS_B)!.emit('exit', { code: 1, signal: null })
  assert.deepEqual(h.router.getPendingCounts(), {})
  assert.deepEqual(h.countsLog.at(-1), {})
})

test('eviction forgets prompt origins, so a late answer falls back to the active manager', () => {
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  h.managers.get(WS_B)!.emit('status-change', 'stopped')
  h.router.respond('b1', { confirmed: true })
  assert.deepEqual(
    h.responses,
    [{ workspaceId: WS_A, id: 'b1', response: { confirmed: true } }],
    'the dead Pi must not be addressed again'
  )
})

test('re-evicting a manager with nothing held emits no further counts', () => {
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  h.managers.get(WS_B)!.emit('status-change', 'stopped')
  const countsAfterEviction = h.countsLog.length
  h.managers.get(WS_B)!.emit('exit', { code: 0, signal: null })
  assert.equal(h.countsLog.length, countsAfterEviction, 'an idle eviction must not churn the renderer')
})

test('a dialog arriving after eviction is held again and answers to its own manager', () => {
  // Pi's buffered stdout can surface a request after the exit event; the late
  // dialog is treated as any other, and the next eviction clears it again.
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('exit', { code: 0, signal: null })
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  assert.deepEqual(h.router.getPendingCounts(), { [WS_B]: 1 })
  h.router.respond('b1', { confirmed: true })
  assert.deepEqual(h.responses, [{ workspaceId: WS_B, id: 'b1', response: { confirmed: true } }])
})

// ─── Ghost guard ─────────────────────────────────────────────────────────────

test('deliverNext drops queued prompts whose extension timeout has expired', () => {
  const h = createHarness([WS_A, WS_B])
  const expired = dialogRequest('b1', { timeout: PROMPT_TIMEOUT_MS })
  const fresh = dialogRequest('b2')
  h.managers.get(WS_B)!.emit('event', expired)
  h.managers.get(WS_B)!.emit('event', fresh)
  h.clock.now = PROMPT_TIMEOUT_MS
  h.setActive(WS_B)
  h.router.flush(WS_B)
  assert.deepEqual(h.broadcasts, [fresh], 'Pi already auto-resolved the expired prompt')
  assert.deepEqual(h.router.getPendingCounts(), { [WS_B]: 1 })
})

test('flush drops an expired delivered dialog and delivers the next queued one', () => {
  const h = createHarness([WS_A])
  const expired = dialogRequest('a1', { timeout: PROMPT_TIMEOUT_MS })
  const fresh = dialogRequest('a2')
  h.managers.get(WS_A)!.emit('event', expired)
  h.managers.get(WS_A)!.emit('event', fresh)
  h.clock.now = PROMPT_TIMEOUT_MS
  h.router.flush(WS_A)
  assert.deepEqual(
    h.broadcasts,
    [expired, fresh],
    'the expired dialog must not be replayed; the fresh one takes the slot'
  )
  assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 1 })
  assert.deepEqual(h.countsLog.at(-1), { [WS_A]: 1 })
})

test('expired queued prompts stop being counted without a workspace visit', () => {
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1', { timeout: PROMPT_TIMEOUT_MS }))
  h.managers.get(WS_B)!.emit('event', dialogRequest('b2', { timeout: PROMPT_TIMEOUT_MS * 2 }))
  h.clock.now = PROMPT_TIMEOUT_MS
  assert.deepEqual(h.router.getPendingCounts(), { [WS_B]: 1 }, 'the elapsed prompt no longer exists in Pi')
  h.clock.now = PROMPT_TIMEOUT_MS * 2
  h.router.handleActiveWorkspaceChanged()
  assert.deepEqual(h.countsLog.at(-1), {}, 'an emptied queue must not linger')
  h.router.respond('b1', { confirmed: true })
  assert.deepEqual(
    h.responses,
    [{ workspaceId: WS_A, id: 'b1', response: { confirmed: true } }],
    'a reaped prompt forgets its origin'
  )
})

// ─── Activation ──────────────────────────────────────────────────────────────

test('activation change re-broadcasts counts without mutating state', () => {
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  const before = h.router.getPendingCounts()
  h.setActive(WS_B)
  h.router.handleActiveWorkspaceChanged()
  assert.deepEqual(h.countsLog.at(-1), before)
  assert.deepEqual(h.router.getPendingCounts(), before)
  assert.deepEqual(h.broadcasts, [], 'activation alone must not deliver anything')
})

// ─── Attachment ──────────────────────────────────────────────────────────────

test('a manager attached after construction is routed like any other', () => {
  const h = createHarness([WS_A])
  const late = h.addManager(WS_B)
  late.emit('event', dialogRequest('b1'))
  assert.deepEqual(h.router.getPendingCounts(), { [WS_B]: 1 })
})

test('attaching the same manager twice does not double-route its events', () => {
  const h = createHarness([WS_A])
  h.router.attachManager(h.managers.get(WS_A)!)
  const event: PiRpcEvent = { type: 'turn_start' }
  h.managers.get(WS_A)!.emit('event', event)
  assert.deepEqual(h.broadcasts, [event])
})
