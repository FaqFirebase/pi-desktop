import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PiRpcManager } from './pi-rpc-manager'
import {
  createExtensionUiRouter,
  wireExtensionUiIpc,
  type ExtensionUiWorkspace,
} from './extension-ui-ipc'
import { IPC_CHANNELS } from '../shared/ipc-contracts'
import type { PendingPromptCounts, PiExtensionUiRequest, PiRpcEvent } from '../shared/ipc-contracts'
import type { PiEventRouter } from './pi-event-router'

const WS_A = 'ws-a'
const WS_B = 'ws-b'
const REQUEST_ID = 'req-1'
/** Status a manager that was never started reports. */
const STOPPED_STATUS = { status: 'stopped', pid: null, error: null, engine: 'pi', startupPhase: undefined }
const PENDING_COUNTS: PendingPromptCounts = { [WS_A]: 2, [WS_B]: 1 }

/** The four channels that answer a blocking extension-UI dialog. */
const RESPONSE_CHANNELS = [
  IPC_CHANNELS.UI_SELECT_RESPONSE,
  IPC_CHANNELS.UI_CONFIRM_RESPONSE,
  IPC_CHANNELS.UI_INPUT_RESPONSE,
  IPC_CHANNELS.UI_EDITOR_RESPONSE,
]
/** The three whose payload is carried through verbatim as `value`. */
const VALUE_CHANNELS = [
  IPC_CHANNELS.UI_SELECT_RESPONSE,
  IPC_CHANNELS.UI_INPUT_RESPONSE,
  IPC_CHANNELS.UI_EDITOR_RESPONSE,
]
const ALL_CHANNELS = [
  ...RESPONSE_CHANNELS,
  IPC_CHANNELS.UI_PENDING_FLUSH,
  IPC_CHANNELS.UI_PENDING_GET,
]

/** Stand-in for IpcMainInvokeEvent: only the sender check ever reads it. */
interface FakeInvokeEvent {
  trusted: boolean
}

const TRUSTED: FakeInvokeEvent = { trusted: true }
const UNTRUSTED: FakeInvokeEvent = { trusted: false }

interface RouterCall {
  method: string
  args: unknown[]
}

interface Broadcast {
  channel: string
  data: unknown
}

interface Harness {
  invoke(channel: string, event: FakeInvokeEvent, ...args: unknown[]): Promise<unknown>
  channels(): string[]
  routerCalls: RouterCall[]
  broadcasts: Broadcast[]
  managerListeners: ((manager: PiRpcManager) => void)[]
  activeListeners: (() => void)[]
  setActivePi(manager: PiRpcManager | null): void
}

/** Records every router call instead of running the real routing logic. */
function recordingRouter(calls: RouterCall[]): PiEventRouter {
  return {
    attachManager: (manager) => calls.push({ method: 'attachManager', args: [manager] }),
    respond: (id, response) => calls.push({ method: 'respond', args: [id, response] }),
    flush: (workspaceId) => calls.push({ method: 'flush', args: [workspaceId] }),
    getPendingCounts: () => {
      calls.push({ method: 'getPendingCounts', args: [] })
      return PENDING_COUNTS
    },
    handleActiveWorkspaceChanged: () =>
      calls.push({ method: 'handleActiveWorkspaceChanged', args: [] }),
  }
}

function createHarness(): Harness {
  const handlers = new Map<string, (event: FakeInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const routerCalls: RouterCall[] = []
  const broadcasts: Broadcast[] = []
  const managerListeners: ((manager: PiRpcManager) => void)[] = []
  const activeListeners: (() => void)[] = []
  let activePi: PiRpcManager | null = null

  const workspace: ExtensionUiWorkspace = {
    getActivePiManager: () => activePi,
    workspaceIdFor: () => null,
    onPiManager: (listener) => managerListeners.push(listener),
    onActiveWorkspaceChanged: (listener) => activeListeners.push(() => listener(null)),
  }

  wireExtensionUiIpc<FakeInvokeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: (event) => {
      if (!event.trusted) throw new Error('Unauthorized IPC sender')
    },
    router: recordingRouter(routerCalls),
    workspace,
    broadcast: (channel, data) => broadcasts.push({ channel, data }),
  })

  return {
    invoke: (channel, event, ...args) => {
      const handler = handlers.get(channel)
      assert.ok(handler, `no handler registered for ${channel}`)
      return handler(event, ...args)
    },
    channels: () => [...handlers.keys()],
    routerCalls,
    broadcasts,
    managerListeners,
    activeListeners,
    setActivePi: (manager) => {
      activePi = manager
    },
  }
}

// --- Response channels ---

test('every extension-UI channel is registered exactly once', () => {
  const h = createHarness()
  assert.deepEqual(h.channels().sort(), [...ALL_CHANNELS].sort())
})

test('value-carrying response channels forward the id and value to the router', async () => {
  for (const channel of VALUE_CHANNELS) {
    const h = createHarness()
    await h.invoke(channel, TRUSTED, REQUEST_ID, 'answer')
    assert.deepEqual(
      h.routerCalls,
      [{ method: 'respond', args: [REQUEST_ID, { value: 'answer' }] }],
      channel,
    )
  }
})

test('the confirm channel forwards a boolean, whatever the renderer sent', async () => {
  const h = createHarness()
  await h.invoke(IPC_CHANNELS.UI_CONFIRM_RESPONSE, TRUSTED, REQUEST_ID, 1)
  await h.invoke(IPC_CHANNELS.UI_CONFIRM_RESPONSE, TRUSTED, REQUEST_ID, undefined)
  assert.deepEqual(h.routerCalls, [
    { method: 'respond', args: [REQUEST_ID, { confirmed: true }] },
    { method: 'respond', args: [REQUEST_ID, { confirmed: false }] },
  ])
})

test('response channels reject a non-string id without touching the router', async () => {
  for (const channel of RESPONSE_CHANNELS) {
    const h = createHarness()
    await assert.rejects(h.invoke(channel, TRUSTED, 42, 'answer'), /id must be a string/, channel)
    assert.deepEqual(h.routerCalls, [], channel)
  }
})

test('every extension-UI channel rejects an untrusted sender before doing anything', async () => {
  for (const channel of ALL_CHANNELS) {
    const h = createHarness()
    await assert.rejects(
      h.invoke(channel, UNTRUSTED, REQUEST_ID, 'answer'),
      /Unauthorized IPC sender/,
      channel,
    )
    assert.deepEqual(h.routerCalls, [], channel)
  }
})

// --- Pending prompts ---

test('the flush channel flushes the requested workspace', async () => {
  const h = createHarness()
  await h.invoke(IPC_CHANNELS.UI_PENDING_FLUSH, TRUSTED, WS_B)
  assert.deepEqual(h.routerCalls, [{ method: 'flush', args: [WS_B] }])
})

test('the flush channel rejects a non-string workspaceId', async () => {
  const h = createHarness()
  await assert.rejects(
    h.invoke(IPC_CHANNELS.UI_PENDING_FLUSH, TRUSTED, { id: WS_B }),
    /workspaceId must be a string/,
  )
  assert.deepEqual(h.routerCalls, [])
})

test('the pending-get channel returns the router counts', async () => {
  const h = createHarness()
  assert.deepEqual(await h.invoke(IPC_CHANNELS.UI_PENDING_GET, TRUSTED), PENDING_COUNTS)
})

// --- Manager and activation hooks ---

test('every Pi manager the workspace announces is attached to the router', () => {
  const h = createHarness()
  assert.equal(h.managerListeners.length, 1, 'the wiring must subscribe to new managers')
  const first = new PiRpcManager()
  const second = new PiRpcManager()
  for (const listener of h.managerListeners) {
    listener(first)
    listener(second)
  }
  assert.deepEqual(h.routerCalls, [
    { method: 'attachManager', args: [first] },
    { method: 'attachManager', args: [second] },
  ])
})

test('an active-workspace change pushes the new workspace Pi status and refreshes counts', () => {
  const h = createHarness()
  h.setActivePi(new PiRpcManager())
  for (const listener of h.activeListeners) listener()
  assert.deepEqual(h.broadcasts, [
    { channel: IPC_CHANNELS.EVENT_PI, data: { type: 'status_change', ...STOPPED_STATUS } },
  ])
  assert.deepEqual(h.routerCalls, [{ method: 'handleActiveWorkspaceChanged', args: [] }])
})

test('an active-workspace change without a Pi manager still refreshes counts', () => {
  const h = createHarness()
  h.setActivePi(null)
  for (const listener of h.activeListeners) listener()
  assert.deepEqual(h.broadcasts, [], 'there is no status to report')
  assert.deepEqual(h.routerCalls, [{ method: 'handleActiveWorkspaceChanged', args: [] }])
})

// --- Router construction ---

interface RouterHarness {
  broadcasts: Broadcast[]
  managers: Map<string, PiRpcManager>
  setActive(workspaceId: string | null): void
}

/**
 * Builds the real router the way the app does, over fake workspace lookups, so
 * the construction wiring itself (which manager is active, which workspace a
 * manager belongs to, which channel each broadcast uses) is exercised.
 */
function createRouterHarness(workspaceIds: string[]): RouterHarness {
  const broadcasts: Broadcast[] = []
  const managers = new Map<string, PiRpcManager>()
  let active: string | null = workspaceIds[0] ?? null

  const workspace: ExtensionUiWorkspace = {
    getActivePiManager: () => (active !== null ? (managers.get(active) ?? null) : null),
    workspaceIdFor: (manager) => {
      for (const [workspaceId, candidate] of managers) {
        if (candidate === manager) return workspaceId
      }
      return null
    },
    onPiManager: () => {},
    onActiveWorkspaceChanged: () => {},
  }

  const router = createExtensionUiRouter({
    workspace,
    broadcast: (channel, data) => broadcasts.push({ channel, data }),
  })
  for (const workspaceId of workspaceIds) {
    const manager = new PiRpcManager()
    managers.set(workspaceId, manager)
    router.attachManager(manager)
  }

  return {
    broadcasts,
    managers,
    setActive: (workspaceId) => {
      active = workspaceId
    },
  }
}

test('the constructed router broadcasts active-workspace Pi events on the Pi event channel', () => {
  const h = createRouterHarness([WS_A, WS_B])
  const event: PiRpcEvent = { type: 'turn_start' }
  h.managers.get(WS_A)!.emit('event', event)
  h.managers.get(WS_B)!.emit('event', { type: 'turn_start' })
  assert.deepEqual(h.broadcasts, [{ channel: IPC_CHANNELS.EVENT_PI, data: event }])
})

test('the constructed router broadcasts pending counts on the pending-prompts channel', () => {
  const h = createRouterHarness([WS_A, WS_B])
  const dialog: PiExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'b1',
    method: 'confirm',
    title: 'Approve?',
  }
  h.managers.get(WS_B)!.emit('event', dialog)
  assert.deepEqual(h.broadcasts, [
    { channel: IPC_CHANNELS.EVENT_PENDING_PROMPTS, data: { [WS_B]: 1 } },
  ])
})
