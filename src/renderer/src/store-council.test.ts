import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AppSettings, CouncilArbiterRequest, CouncilCancelRequest, CouncilProgressEvent, CouncilRunRequest, SessionRuntimeInfo, Workspace } from '../../shared/ipc-contracts'
import { DEFAULT_COUNCIL_CONFIG, type ConsultantResult } from '../../shared/council-config'

// Prompts the store sent, in order.
const calls: string[] = []
const consultantRequests: CouncilRunRequest[] = []
const arbiterRequests: CouncilArbiterRequest[] = []
const cancelRequests: CouncilCancelRequest[] = []
const progressListeners = new Set<(event: CouncilProgressEvent) => void>()
// The live consensus text the arbiter saw while it streamed, per arbiter call.
const consensusWhileMerging: string[] = []
const STALE_RUN_ID = 'run-that-was-cancelled'
const STALE_CHUNK = 'chunk of the old run'
const CURRENT_CHUNK = 'chunk of this run'
const ACCEPTED = { type: 'response', command: 'prompt', success: true }
const PLAN = 'Step 1: change the parser.'
const RESULTS: ConsultantResult[] = [
  { id: 'pi', status: 'contributed', plan: 'Pi plan' },
  { id: 'claude', status: 'contributed', plan: 'Claude plan' },
]
const WORKSPACE_A = { id: 'ws-a' } as Workspace
const WORKSPACE_B = { id: 'ws-b' } as Workspace
// Chats are keyed by their session runtime id.
const CHAT_A = 'runtime-a'
const CHAT_B = 'runtime-b'
// A gated step that never opens must fail the test, not hang it.
const TEST_DEADLINE_MS = 5000

// Non-null holds runConsultants until the test opens the gate.
let consultantGate: Promise<void> | null = null
let openConsultantGate: () => void = () => undefined

function gateConsultants(): void {
  consultantGate = new Promise((resolve) => { openConsultantGate = resolve })
}

/** Main broadcasts progress to every listener, whatever run it belongs to. */
function emitProgress(event: CouncilProgressEvent): void {
  for (const listener of progressListeners) listener(event)
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + TEST_DEADLINE_MS
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const piDesktopStub = {
  commands: {
    prompt: async (message: string) => {
      calls.push(`prompt:${message}`)
      return ACCEPTED
    },
  },
  council: {
    detect: async () => ({ agents: [{ id: 'pi', found: true }, { id: 'claude', found: true }, { id: 'codex', found: false }] }),
    runConsultants: async (payload: CouncilRunRequest) => {
      consultantRequests.push(payload)
      if (consultantGate) await consultantGate
      return { results: RESULTS }
    },
    arbiter: async (payload: CouncilArbiterRequest) => {
      arbiterRequests.push(payload)
      emitProgress({ runId: STALE_RUN_ID, id: 'pi', chunk: STALE_CHUNK })
      emitProgress({ runId: payload.runId, id: 'pi', chunk: CURRENT_CHUNK })
      consensusWhileMerging.push(useAppStore.getState().councilRun?.consensus ?? '')
      return { plan: PLAN }
    },
    cancel: async (payload: CouncilCancelRequest) => {
      cancelRequests.push(payload)
    },
    onProgress: (listener: (event: CouncilProgressEvent) => void) => {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
  },
  session: {
    // The engine runs the turn it was sent, so no prompt ends without an agent.
    getState: async () => ({ success: true, data: { isStreaming: true } }),
    getStats: async () => ({ success: true, data: null }),
    list: async () => [],
  },
}

type StoreModule = typeof import('./store')
let useAppStore: StoreModule['useAppStore']
let councilRunOnScreen: StoreModule['councilRunOnScreen']

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore, councilRunOnScreen } = await import('./store'))
})

beforeEach(() => {
  calls.length = 0
  consultantRequests.length = 0
  arbiterRequests.length = 0
  cancelRequests.length = 0
  consensusWhileMerging.length = 0
  consultantGate = null
  useAppStore.setState({
    messages: [],
    isStreaming: false,
    piStatus: 'running',
    piEngine: 'pi',
    settings: { council: { ...DEFAULT_COUNCIL_CONFIG, enabled: true } } as AppSettings,
    councilRun: null,
    sessionRuntimes: {},
    sendQueues: {},
    heldSendQueues: {},
  })
  showChat(WORKSPACE_A, CHAT_A)
})

function showChat(workspace: Workspace, chatId: string): void {
  useAppStore.setState({ activeWorkspace: workspace, activeSessionRuntimeId: chatId })
}

function promptsSent(): string[] {
  return calls.filter((call) => call.startsWith('prompt:'))
}

test('Approve sends a council plan only in the chat that started the run', async () => {
  await useAppStore.getState().runCouncil('Fix the parser')
  assert.equal(useAppStore.getState().councilRun?.phase, 'awaiting-approval')

  showChat(WORKSPACE_B, CHAT_B)
  assert.equal(councilRunOnScreen(useAppStore.getState()), null, 'the plan of workspace A must not show in B')
  await useAppStore.getState().approveCouncilPlan()
  assert.deepEqual(promptsSent(), [])
  assert.equal(useAppStore.getState().councilRun?.consensus, PLAN, 'the plan waits for its own chat')

  showChat(WORKSPACE_A, CHAT_A)
  assert.equal(councilRunOnScreen(useAppStore.getState())?.consensus, PLAN)
  await useAppStore.getState().approveCouncilPlan()
  assert.equal(promptsSent().length, 1)
  assert.ok(promptsSent()[0].includes(PLAN))
  assert.equal(useAppStore.getState().councilRun, null)
})

test('the consultants and the arbiter work in the workspace the council started in', { timeout: TEST_DEADLINE_MS }, async () => {
  gateConsultants()
  const run = useAppStore.getState().runCouncil('Fix the parser')
  showChat(WORKSPACE_B, CHAT_B)
  openConsultantGate()
  await run

  assert.deepEqual(consultantRequests.map((request) => request.workspaceId), [WORKSPACE_A.id])
  assert.deepEqual(arbiterRequests.map((request) => request.workspaceId), [WORKSPACE_A.id])
})

test('a council run another chat owns is kept, and a new run there is refused with a reason', async () => {
  await useAppStore.getState().runCouncil('Fix the parser')
  const owned = useAppStore.getState().councilRun

  showChat(WORKSPACE_B, CHAT_B)
  await useAppStore.getState().runCouncil('Something else')
  assert.equal(useAppStore.getState().councilRun, owned)
  assert.equal(useAppStore.getState().messages.length, 1)
  assert.equal(useAppStore.getState().messages[0].role, 'system')
  assert.match(useAppStore.getState().messages[0].content, /another chat/)
})

test('a cancelled council run never comes back when its consultants finish', { timeout: TEST_DEADLINE_MS }, async () => {
  gateConsultants()
  const run = useAppStore.getState().runCouncil('Fix the parser')
  await until(() => consultantRequests.length === 1, 'the consultants to start')
  useAppStore.getState().cancelCouncil()
  openConsultantGate()
  await run

  assert.equal(useAppStore.getState().councilRun, null)
  assert.deepEqual(arbiterRequests, [], 'a cancelled run must not start the arbiter')
})

test('cancel asks main to stop the consultants of that run', { timeout: TEST_DEADLINE_MS }, async () => {
  gateConsultants()
  const run = useAppStore.getState().runCouncil('Fix the parser')
  await until(() => consultantRequests.length === 1, 'the consultants to start')
  useAppStore.getState().cancelCouncil()
  assert.deepEqual(cancelRequests, [{ runId: consultantRequests[0].runId }])
  openConsultantGate()
  await run
})

test('a run cancelled while it detects agents starts no consultant', async () => {
  const run = useAppStore.getState().runCouncil('Fix the parser')
  useAppStore.getState().cancelCouncil()
  await run
  assert.deepEqual(consultantRequests, [])
  assert.equal(useAppStore.getState().councilRun, null)
})

test('progress of an old run never reaches the partials or the consensus of a new run', { timeout: TEST_DEADLINE_MS }, async () => {
  gateConsultants()
  const oldRun = useAppStore.getState().runCouncil('Old request')
  await until(() => consultantRequests.length === 1, 'the old consultants to start')
  useAppStore.getState().cancelCouncil()
  const newRun = useAppStore.getState().runCouncil('New request')
  await until(() => consultantRequests.length === 2, 'the new consultants to start')
  const [oldRequest, newRequest] = consultantRequests
  assert.notEqual(oldRequest.runId, newRequest.runId)

  emitProgress({ runId: oldRequest.runId, id: 'claude', chunk: STALE_CHUNK })
  emitProgress({ runId: newRequest.runId, id: 'pi', chunk: CURRENT_CHUNK })
  assert.deepEqual(useAppStore.getState().councilRun?.partials, { pi: CURRENT_CHUNK })

  openConsultantGate()
  await Promise.all([oldRun, newRun])
  assert.deepEqual(arbiterRequests.map((request) => request.runId), [newRequest.runId])
  assert.deepEqual(consensusWhileMerging, [CURRENT_CHUNK])
})

test('closing the chat that owns a council run drops the run', async () => {
  await useAppStore.getState().runCouncil('Fix the parser')
  const closed: SessionRuntimeInfo = {
    runtimeId: CHAT_A, workspaceId: WORKSPACE_A.id, sessionPath: null, sessionId: null,
    status: 'stopped', pid: null, error: null, activity: null, active: false, closed: true,
  }
  const runId = useAppStore.getState().councilRun?.id
  useAppStore.getState().handleSessionRuntime(closed)
  assert.equal(useAppStore.getState().councilRun, null)
  assert.deepEqual(cancelRequests, [{ runId }])
})
