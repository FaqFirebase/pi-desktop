import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent, SessionRuntimeInfo, Workspace } from '../../shared/ipc-contracts'
import type { ComposerAttachment } from './store'

// Prompts, steers and stops the store sent, in order.
const calls: string[] = []
const ACCEPTED = { type: 'response', command: 'prompt', success: true }
const WORKSPACE_ID = 'ws-queue'
const OTHER_WORKSPACE_ID = 'ws-other'
// Chats are keyed by their session runtime id.
const CHAT_ID = 'runtime-queue'
const OTHER_CHAT_ID = 'runtime-other'

const piDesktopStub = {
  workspace: {
    list: async () => [{ id: WORKSPACE_ID } as Workspace],
    getActive: async () => ({ id: WORKSPACE_ID } as Workspace),
    remove: async () => ({}),
  },
  pi: {
    getStatus: async () => ({ status: 'running' as const, pid: 1, error: null }),
  },
  commands: {
    prompt: async (message: string) => {
      calls.push(`prompt:${message}`)
      return ACCEPTED
    },
    steer: async (message: string) => {
      calls.push(`steer:${message}`)
      return { type: 'response', command: 'steer', success: true }
    },
    abort: async () => {
      calls.push('abort')
      return { type: 'response', command: 'abort', success: true }
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
let turnActivityTimes: StoreModule['turnActivityTimes']

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore, turnActivityTimes } = await import('./store'))
})

beforeEach(() => {
  calls.length = 0
  useAppStore.setState({
    messages: [],
    timelineEvents: [],
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
    isStreaming: true,
    piStatus: 'running',
    piEngine: 'pi',
    activeWorkspace: { id: WORKSPACE_ID } as Workspace,
    activeSessionRuntimeId: CHAT_ID,
    sessionRuntimes: {},
    sendQueues: {},
    heldSendQueues: {},
    councilRun: null,
    confirmRequest: null,
  })
})

function emit(event: PiRpcEvent): void {
  useAppStore.getState().handlePiEvent(event)
}

// Let the async send chain (sendPrompt -> commands.prompt) run.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

function queue(text: string, attachments: ComposerAttachment[] = [], chatId = CHAT_ID): void {
  useAppStore.getState().queuePrompt(chatId, text, attachments)
}

function queuedTexts(chatId = CHAT_ID): string[] {
  return (useAppStore.getState().sendQueues[chatId] ?? []).map((prompt) => prompt.text)
}

function runtime(runtimeId: string, patch: Partial<SessionRuntimeInfo> = {}): SessionRuntimeInfo {
  return {
    runtimeId, workspaceId: WORKSPACE_ID, sessionPath: null, sessionId: null,
    status: 'running', pid: 1, error: null, activity: 'working', active: false,
    ...patch,
  }
}

// Open another chat: main reports the chat left as a background runtime.
function leaveChatFor(chatId: string, left: Partial<SessionRuntimeInfo> = {}): void {
  useAppStore.setState({ activeSessionRuntimeId: chatId })
  useAppStore.getState().handleSessionRuntime(runtime(CHAT_ID, left))
}

function endTurn(): void {
  emit({ type: 'agent_end', messages: [] } as PiRpcEvent)
}

test('the end of a turn sends the oldest queued message as a new prompt, one per turn', async () => {
  queue('first')
  queue('second')
  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:first'])
  assert.deepEqual(queuedTexts(), ['second'])
  assert.equal(useAppStore.getState().isStreaming, true)

  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:first', 'prompt:second'])
  assert.deepEqual(queuedTexts(), [])
})

test('a stopped turn holds the queue until the user sends again', async () => {
  queue('waiting')
  await useAppStore.getState().abort()
  endTurn()
  await settle()
  assert.deepEqual(calls, ['abort'])
  assert.deepEqual(queuedTexts(), ['waiting'])
  assert.deepEqual(useAppStore.getState().heldSendQueues, { [CHAT_ID]: 'interrupted' })

  await useAppStore.getState().sendPrompt('new task')
  assert.deepEqual(useAppStore.getState().heldSendQueues, {})
  endTurn()
  await settle()
  assert.deepEqual(calls, ['abort', 'prompt:new task', 'prompt:waiting'])
})

test('a failed turn holds the queue, and a retry that works does not', async () => {
  queue('waiting')
  emit({ type: 'agent_start' } as PiRpcEvent)
  emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider down' } } as PiRpcEvent)
  endTurn()
  await settle()
  assert.deepEqual(calls, [])
  assert.deepEqual(useAppStore.getState().heldSendQueues, { [CHAT_ID]: 'interrupted' })

  useAppStore.setState({ heldSendQueues: {}, isStreaming: true })
  emit({ type: 'agent_start' } as PiRpcEvent)
  emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider down' } } as PiRpcEvent)
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } } as PiRpcEvent)
  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:waiting'])
})

test('Send now pushes a queued message into the running turn and takes it off the queue', async () => {
  queue('keep going')
  queue('later')
  const [first] = useAppStore.getState().sendQueues[CHAT_ID]
  await useAppStore.getState().sendQueuedPromptNow(CHAT_ID, first.id)
  assert.deepEqual(calls, ['steer:keep going'])
  assert.deepEqual(queuedTexts(), ['later'])
})

test('a queued message keeps its files: text files go out inlined', async () => {
  const notes: ComposerAttachment = { kind: 'text', name: 'notes.md', path: '/p/notes.md', content: 'Line one' }
  queue('Read this', [notes])
  endTurn()
  await settle()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].startsWith('prompt:Read this'))
  assert.ok(calls[0].includes('Line one'))
})

test('only the queue of the chat on screen goes out, and only in that chat', async () => {
  queue('elsewhere', [], OTHER_CHAT_ID)
  endTurn()
  await settle()
  assert.deepEqual(calls, [])
  const [elsewhere] = useAppStore.getState().sendQueues[OTHER_CHAT_ID]
  await useAppStore.getState().sendQueuedPromptNow(OTHER_CHAT_ID, elsewhere.id)
  assert.deepEqual(calls, [])
  assert.deepEqual(queuedTexts(OTHER_CHAT_ID), ['elsewhere'])
})

test('a queued message stays with its chat when another chat of the workspace opens', async () => {
  queue('do X')
  leaveChatFor(OTHER_CHAT_ID)
  // The other chat's turn ends: the message is not its own.
  endTurn()
  await settle()
  assert.deepEqual(calls, [])
  assert.deepEqual(queuedTexts(), ['do X'])

  // Back in the chat while its turn still runs: its end sends the message there.
  useAppStore.setState({ activeSessionRuntimeId: CHAT_ID, isStreaming: true })
  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:do X'])
})

test('a chat whose turn ended off screen holds its queue until Send now', async () => {
  queue('older')
  queue('second')
  useAppStore.getState().handleSessionRuntime(runtime(CHAT_ID, { active: true }))
  leaveChatFor(OTHER_CHAT_ID)
  // The turn ends in the background; this window never sees its agent_end.
  useAppStore.getState().handleSessionRuntime(runtime(CHAT_ID, { activity: 'completed' }))
  assert.deepEqual(useAppStore.getState().heldSendQueues, { [CHAT_ID]: 'ended-off-screen' })

  // Back in the chat, the user sends a newer prompt: the old ones stay held.
  useAppStore.setState({ activeSessionRuntimeId: CHAT_ID, isStreaming: false })
  await useAppStore.getState().sendPrompt('newer')
  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:newer'])
  assert.deepEqual(queuedTexts(), ['older', 'second'])

  // Send now sends one; the rest stays held until the queue is empty.
  const [older] = useAppStore.getState().sendQueues[CHAT_ID]
  await useAppStore.getState().sendQueuedPromptNow(CHAT_ID, older.id)
  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:newer', 'prompt:older'])
  const [last] = useAppStore.getState().sendQueues[CHAT_ID]
  await useAppStore.getState().sendQueuedPromptNow(CHAT_ID, last.id)
  assert.deepEqual(useAppStore.getState().heldSendQueues, {})
})

test('an interrupted chat that leaves the screen while idle keeps its interrupted hold', async () => {
  queue('waiting')
  await useAppStore.getState().abort()
  endTurn()
  await settle()
  leaveChatFor(OTHER_CHAT_ID, { activity: 'completed' })
  useAppStore.getState().handleSessionRuntime(runtime(CHAT_ID, { activity: 'completed' }))
  assert.deepEqual(useAppStore.getState().heldSendQueues, { [CHAT_ID]: 'interrupted' })

  // Back in the chat, the user's next send still releases the queue.
  useAppStore.setState({ activeSessionRuntimeId: CHAT_ID, isStreaming: false })
  await useAppStore.getState().sendPrompt('new task')
  endTurn()
  await settle()
  assert.deepEqual(calls, ['abort', 'prompt:new task', 'prompt:waiting'])
})

test('an interrupted chat whose turn then ends off screen holds until Send now', async () => {
  queue('waiting')
  await useAppStore.getState().abort()
  endTurn()
  await settle()
  // A turn runs off screen and ends there: the window never sees its end.
  leaveChatFor(OTHER_CHAT_ID, { activity: 'working' })
  useAppStore.getState().handleSessionRuntime(runtime(CHAT_ID, { activity: 'completed' }))
  assert.deepEqual(useAppStore.getState().heldSendQueues, { [CHAT_ID]: 'ended-off-screen' })
})

test('a chat that leaves the screen mid-turn does not hold its queue', () => {
  queue('waiting')
  leaveChatFor(OTHER_CHAT_ID, { activity: 'working' })
  assert.deepEqual(useAppStore.getState().heldSendQueues, {})
})

test('closing a chat drops its queue and its hold', async () => {
  queue('gone')
  await useAppStore.getState().abort()
  queue('kept', [], OTHER_CHAT_ID)
  useAppStore.getState().handleSessionRuntime(runtime(CHAT_ID, { closed: true, activity: null }))
  assert.deepEqual(queuedTexts(), [])
  assert.deepEqual(useAppStore.getState().heldSendQueues, {})
  assert.deepEqual(queuedTexts(OTHER_CHAT_ID), ['kept'])
})

test('removing a workspace drops the queues of its chats', async () => {
  useAppStore.setState({
    sessionRuntimes: {
      [CHAT_ID]: runtime(CHAT_ID, { workspaceId: OTHER_WORKSPACE_ID }),
      [OTHER_CHAT_ID]: runtime(OTHER_CHAT_ID),
    },
  })
  queue('gone')
  queue('kept', [], OTHER_CHAT_ID)
  const removal = useAppStore.getState().removeWorkspace(OTHER_WORKSPACE_ID)
  useAppStore.getState().resolveConfirm(true)
  await removal
  assert.deepEqual(queuedTexts(), [])
  assert.deepEqual(queuedTexts(OTHER_CHAT_ID), ['kept'])
})

test('the activity clock starts with the turn and moves with every agent event', async () => {
  useAppStore.setState({ isStreaming: false })
  const beforeStart = Date.now()
  useAppStore.setState({ isStreaming: true })
  const { startedAt, lastEventAt } = turnActivityTimes()
  assert.ok(startedAt >= beforeStart)
  assert.equal(lastEventAt, startedAt)

  await new Promise((resolve) => setTimeout(resolve, 5))
  emit({ type: 'queue_update', steering: [], followUp: [] })
  assert.ok(turnActivityTimes().lastEventAt > startedAt)
  assert.equal(turnActivityTimes().startedAt, startedAt)
})
