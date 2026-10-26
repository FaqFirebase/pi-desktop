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
    options: ['answer'],
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
  revocations: PiRpcEvent[]
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
  const revocations: PiRpcEvent[] = []
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
    broadcastEvent: (event) => {
      if (event.type === 'extension_ui_request' && event.method === 'cancel') revocations.push(event)
      else broadcasts.push(event)
    },
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
    revocations,
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
    const response = method === 'confirm' ? { confirmed: true } : { value: 'answer' }
    h.router.respond('b1', response)
    assert.deepEqual(h.responses, [], 'an undelivered dialog has no authorized answering view')
    h.setActive(WS_B)
    h.router.flush(WS_B)
    h.router.respond('b1', response)
    assert.deepEqual(h.responses, [{ workspaceId: WS_B, id: 'b1', response }])
    assert.deepEqual(h.countsLog, [{ [WS_B]: 1 }, { [WS_B]: 1 }, {}])
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
    const response = method === 'confirm' ? { confirmed: true } : { value: 'answer' }
    h.router.respond('a1', response)
    assert.deepEqual(h.responses, [{ workspaceId: WS_A, id: 'a1', response }])
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
  assert.deepEqual(h.responses, [], 'a revoked view cannot consume its old dialog')
  assert.deepEqual(h.broadcasts, [first], 'the queued dialog must wait for the switch back')
  assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 2 })
  h.setActive(WS_A)
  h.router.flush(WS_A)
  h.router.respond('a1', { confirmed: true })
  assert.deepEqual(h.broadcasts, [first, first, second], 'switching back restores the unanswered dialog before chaining')
})

test('respond with an unknown id never falls back to the active manager', () => {
  const h = createHarness([WS_A])
  h.router.respond('ghost', { value: '' })
  assert.deepEqual(h.responses, [])
})

test('a cancelled response is a legal first-class answer for every blocking method', () => {
  for (const method of BLOCKING_METHODS) {
    const h = createHarness([WS_A])
    const request = dialogRequest('cancel-me', { method })
    h.managers.get(WS_A)!.emit('event', request)
    h.router.respond('cancel-me', { cancelled: true })
    assert.deepEqual(h.responses, [{ workspaceId: WS_A, id: 'cancel-me', response: { cancelled: true } }], method)
    assert.deepEqual(h.router.getPendingCounts(), {}, 'a cancel consumes the request like any answer')
  }
})

test('a select cancel must not be disguised as an empty option', () => {
  const h = createHarness([WS_A])
  const request = dialogRequest('select-cancel', { method: 'select' })
  h.managers.get(WS_A)!.emit('event', request)
  assert.throws(() => h.router.respond('select-cancel', { value: '' }), /Invalid selection/)
  assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 1 }, 'the rejected empty value leaves the request pending')
  h.router.respond('select-cancel', { cancelled: true })
  assert.deepEqual(h.responses, [{ workspaceId: WS_A, id: 'select-cancel', response: { cancelled: true } }])
})

test('respond with no origin and no active manager drops silently', () => {
  const h = createHarness([WS_A], null)
  h.router.respond('ghost', { value: '' })
  assert.deepEqual(h.responses, [])
})

test('an undelivered queued dialog cannot be answered before it owns a view', () => {
  const h = createHarness([WS_A])
  const first = dialogRequest('a1')
  const second = dialogRequest('a2')
  h.managers.get(WS_A)!.emit('event', first)
  h.managers.get(WS_A)!.emit('event', second)
  h.router.respond('a2', { confirmed: true })
  assert.equal(h.responses.length, 0)
  assert.deepEqual(h.router.getPendingCounts(), { [WS_A]: 2 })
  h.router.respond('a1', { confirmed: true })
  assert.deepEqual(h.broadcasts, [first, second])
  h.router.respond('a2', { confirmed: true })
  assert.deepEqual(h.responses.map((response) => response.id), ['a1', 'a2'])
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

test('eviction forgets prompt origins and drops late answers instead of addressing the active manager', () => {
  const h = createHarness([WS_A, WS_B])
  h.managers.get(WS_B)!.emit('event', dialogRequest('b1'))
  h.managers.get(WS_B)!.emit('status-change', 'stopped')
  h.router.respond('b1', { confirmed: true })
  assert.deepEqual(h.responses, [], 'neither the dead Pi nor the unrelated active Pi may receive a stale answer')
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
  h.setActive(WS_B)
  h.router.flush(WS_B)
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
  assert.deepEqual(h.responses, [], 'a reaped prompt cannot fall back to a different session')
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

function dualViewHarness() {
  const alpha = new PiRpcManager()
  const beta = new PiRpcManager()
  let active = beta
  let secondary: PiRpcManager | null = alpha
  let visible = true
  const mainEvents: PiRpcEvent[] = []
  const secondaryEvents: PiRpcEvent[] = []
  const approvals: Array<PiExtensionUiRequest | null> = []
  const responses: Array<{ manager: PiRpcManager; id: string; response: Record<string, unknown> }> = []
  const router = createPiEventRouter({
    getActiveManager: () => active,
    workspaceIdFor: (manager) => manager === alpha ? WS_A : WS_B,
    getSecondaryManager: () => secondary,
    preferSecondaryView: () => visible,
    sendSecondaryEvent: (manager, event) => { if (manager === secondary) secondaryEvents.push(event) },
    sendSecondaryApproval: (manager, request) => { if (manager === secondary) approvals.push(request) },
    broadcastEvent: (event) => mainEvents.push(event),
    broadcastPendingCounts: () => {},
    now: () => 0,
  })
  for (const manager of [alpha, beta]) {
    manager.sendExtensionUiResponse = (id, response) => { responses.push({ manager, id, response }) }
    router.attachManager(manager)
  }
  return {
    router, alpha, beta, mainEvents, secondaryEvents, approvals, responses,
    useMain: (manager: PiRpcManager) => { active = manager; router.handleActiveWorkspaceChanged() },
    show: (shown: boolean) => { visible = shown; router.refreshOwners() },
    select: (manager: PiRpcManager | null) => { secondary = manager; router.refreshOwners() },
  }
}

test('inactive secondary session streams and approvals stay independent of the main active session', () => {
  const h = dualViewHarness()
  const alphaTurn: PiRpcEvent = { type: 'turn_start' }
  const betaTurn: PiRpcEvent = { type: 'turn_end', message: {}, toolResults: [] }
  h.alpha.emit('event', alphaTurn)
  h.beta.emit('event', betaTurn)
  assert.deepEqual(h.secondaryEvents, [alphaTurn])
  assert.deepEqual(h.mainEvents, [betaTurn])
  const request = dialogRequest('background-approval')
  h.alpha.emit('event', request)
  assert.deepEqual(h.approvals, [request])
  assert.deepEqual(h.mainEvents, [betaTurn])
  h.router.respond(request.id, { confirmed: true }, 'main')
  assert.deepEqual(h.responses, [], 'main cannot act on a secondary-owned approval')
  h.show(false)
  assert.equal(h.router.getSecondaryRequest()?.id, request.id)
  assert.deepEqual(h.responses, [], 'hiding never answers or denies a pending request')
  h.router.respond(request.id, { confirmed: true }, 'secondary')
  h.router.respond(request.id, { confirmed: false }, 'secondary')
  assert.deepEqual(h.responses, [{ manager: h.alpha, id: request.id, response: { confirmed: true } }])
  assert.equal(h.approvals.at(-1), null)
})

test('approval ownership transfers revoke the old main view and only the first current owner can answer', () => {
  const h = dualViewHarness()
  h.select(null)
  h.useMain(h.alpha)
  const request = dialogRequest('shared-approval')
  h.alpha.emit('event', request)
  assert.deepEqual(h.mainEvents, [request])
  h.select(h.alpha)
  assert.equal(h.approvals.at(-1)?.id, request.id)
  assert.deepEqual(h.mainEvents.at(-1), {
    type: 'extension_ui_request', method: 'cancel', id: request.id, targetId: request.id,
  })
  h.router.respond(request.id, { confirmed: false }, 'main')
  assert.equal(h.responses.length, 0)
  h.router.respond(request.id, { confirmed: true }, 'secondary')
  h.router.respond(request.id, { confirmed: false }, 'main')
  assert.equal(h.responses.length, 1)
  assert.equal(h.responses[0].manager, h.alpha)
})

test('invalid approval response types do not consume the request and engine cancellation revokes it', () => {
  const h = dualViewHarness()
  const request = dialogRequest('validate-approval')
  h.alpha.emit('event', request)
  assert.throws(() => h.router.respond(request.id, { confirmed: 'yes' }, 'secondary'), /Invalid extension UI response/)
  assert.throws(() => h.router.respond(request.id, { value: 'yes' }, 'secondary'), /Invalid extension UI response/)
  assert.equal(h.router.getSecondaryRequest()?.id, request.id)
  h.alpha.emit('event', { type: 'extension_ui_request', method: 'cancel', id: 'cancel', targetId: request.id })
  assert.equal(h.router.getSecondaryRequest(), null)
  h.router.respond(request.id, { confirmed: true }, 'secondary')
  assert.deepEqual(h.responses, [])
})
