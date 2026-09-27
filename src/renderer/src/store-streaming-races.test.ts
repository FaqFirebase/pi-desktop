import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionRuntimeInfo, SessionState } from '../../shared/ipc-contracts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

type HistoryResponse = { success: boolean; data: { messages: unknown[] } }
const historyRequests: ReturnType<typeof deferred<HistoryResponse>>[] = []
const stateRequests: ReturnType<typeof deferred<{ success: boolean; data: SessionState }>>[] = []
let steerError: Error | null = null
const workspace = { id: 'ws', name: 'project', path: '/project', createdAt: 0, lastActiveAt: 0, color: '#000' }
const runtime: SessionRuntimeInfo = {
  runtimeId: 'rt', workspaceId: workspace.id, sessionPath: '/session.jsonl', sessionId: 'session',
  status: 'running', pid: 1, error: null, activity: 'working', active: true,
}
const bridge = {
  session: {
    getMessages: () => {
      const request = deferred<HistoryResponse>()
      historyRequests.push(request)
      return request.promise
    },
    getState: () => {
      const request = deferred<{ success: boolean; data: SessionState }>()
      stateRequests.push(request)
      return request.promise
    },
    getStats: async () => null,
    list: async () => [],
  },
  commands: {
    steer: async () => { if (steerError) throw steerError },
  },
}

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore
before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: bridge }
  ;({ useAppStore } = await import('./store'))
})
beforeEach(() => {
  useAppStore.getState().clearMessages()
  historyRequests.length = 0
  stateRequests.length = 0
  steerError = null
  useAppStore.setState({
    piStatus: 'running', activeWorkspace: workspace, activeSessionRuntimeId: runtime.runtimeId,
    sessionRuntimes: { [runtime.runtimeId]: runtime }, sessionState: { sessionFile: runtime.sessionPath } as SessionState,
    sessionLoading: false, timelineEvents: [], workspaceActivity: {}, settings: null,
  })
})

const answer = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
function stream(text: string): void {
  useAppStore.getState().handlePiEvent({
    type: 'message_update', message: answer(text), assistantMessageEvent: { type: 'text_delta', delta: text },
  })
}
function finish(text: string): void {
  useAppStore.getState().handlePiEvent({ type: 'message_end', message: answer(text) })
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('same-session history refresh never clears the visible response or live tools', async () => {
  useAppStore.setState({
    isStreaming: true, streamingContent: 'visible response', streamingThinking: 'visible reasoning',
    streamingToolCalls: new Map([['tool', { name: 'read', args: '{}', isExecuting: true }]]),
    messages: [{ id: 'visible', role: 'user', content: 'Question', timestamp: 1 }],
  })
  const before = useAppStore.getState()
  const load = before.reloadActiveSession({ refreshList: false })
  assert.equal(useAppStore.getState().messages, before.messages)
  assert.equal(useAppStore.getState().streamingContent, before.streamingContent)
  assert.equal(useAppStore.getState().streamingToolCalls, before.streamingToolCalls)
  assert.equal(useAppStore.getState().isStreaming, true)
  historyRequests[0].resolve({ success: true, data: { messages: [] } })
  await load
  assert.equal(useAppStore.getState().streamingContent, 'visible response')
  assert.equal(useAppStore.getState().messages, before.messages, 'a snapshot missing the local prompt must not erase it')
})

test('late history cannot overwrite a response completed while the request was in flight', async () => {
  useAppStore.setState({ isStreaming: true })
  const load = useAppStore.getState().reloadActiveSession({ refreshList: false })
  stream('new answer')
  finish('new answer')
  historyRequests[0].resolve({ success: true, data: { messages: [answer('old snapshot')] } })
  await load
  assert.deepEqual(useAppStore.getState().messages.map((message) => message.content), ['new answer'])
  assert.equal(useAppStore.getState().sessionLoading, false)
})

test('only the newest history request may publish its result', async () => {
  const first = useAppStore.getState().reloadActiveSession({ refreshList: false })
  const second = useAppStore.getState().reloadActiveSession({ refreshList: false })
  historyRequests[1].resolve({ success: true, data: { messages: [answer('new snapshot')] } })
  await second
  historyRequests[0].resolve({ success: true, data: { messages: [answer('old snapshot')] } })
  await first
  assert.deepEqual(useAppStore.getState().messages.map((message) => message.content), ['new snapshot'])
})

test('runtime broadcasts do not start duplicate hydration while the state RPC is pending', async () => {
  useAppStore.setState({ sessionState: null, sessionLoading: true })
  useAppStore.getState().handleSessionRuntime(runtime)
  useAppStore.getState().handleSessionRuntime({ ...runtime, activity: 'needs-approval' })
  assert.equal(historyRequests.length, 1)
  historyRequests[0].resolve({ success: true, data: { messages: [] } })
  await tick()
})

test('the selected runtime stays visibly working while its history is loading', async () => {
  useAppStore.setState({ sessionState: null, sessionLoading: true })
  useAppStore.getState().handleSessionRuntime(runtime)
  assert.equal(useAppStore.getState().isStreaming, true)
  assert.equal(useAppStore.getState().reattachedMidTurn, true)
  historyRequests[0].resolve({ success: true, data: { messages: [] } })
  await tick()
  assert.equal(useAppStore.getState().isStreaming, true)
})

test('a late session state response cannot replace the currently selected session', async () => {
  const load = useAppStore.getState().refreshSessionState()
  const selected = { sessionFile: '/other.jsonl' } as SessionState
  useAppStore.setState({ activeSessionRuntimeId: 'other', sessionState: selected })
  stateRequests[0].resolve({ success: true, data: { sessionFile: runtime.sessionPath } as SessionState })
  await load
  assert.equal(useAppStore.getState().sessionState, selected)
})

test('message completion after reattachment uses the final body without reloading the chat', async () => {
  useAppStore.setState({ isStreaming: true, reattachedMidTurn: true })
  stream('suffix')
  finish('prefix and suffix')
  stream('next response')
  await tick()
  assert.equal(historyRequests.length, 0)
  assert.equal(useAppStore.getState().messages[0]?.content, 'prefix and suffix')
  assert.equal(useAppStore.getState().streamingContent, 'next response')
  assert.equal(useAppStore.getState().isStreaming, true)
})

test('steering and a rejected steer preserve the response already on screen', async () => {
  useAppStore.setState({ isStreaming: true, streamingContent: 'in progress', streamingThinking: 'reasoning' })
  await useAppStore.getState().sendPrompt('additional instruction')
  assert.equal(useAppStore.getState().streamingContent, 'in progress')
  steerError = new Error('steer rejected')
  await useAppStore.getState().sendPrompt('another instruction')
  assert.equal(useAppStore.getState().streamingContent, 'in progress')
  assert.equal(useAppStore.getState().streamingThinking, 'reasoning')
  assert.equal(useAppStore.getState().isStreaming, true)
})

test('another session working in the same workspace never starts this chat spinner', () => {
  useAppStore.setState({ sessionRuntimes: { [runtime.runtimeId]: { ...runtime, activity: null } } })
  useAppStore.getState().handleWorkspaceActivity({ [workspace.id]: { state: 'working', since: 1 } })
  assert.equal(useAppStore.getState().isStreaming, false)
  assert.equal(useAppStore.getState().reattachedMidTurn, false)
})

test('an idle history backfill preserves message keys and expanded streamed reasoning', async () => {
  useAppStore.setState({ messages: [{
    id: 'existing', role: 'assistant', content: 'answer', thinking: 'reasoning', timestamp: 1,
    initiallyShowThinking: true,
  }] })
  const load = useAppStore.getState().reloadActiveSession({ refreshList: false })
  historyRequests[0].resolve({ success: true, data: { messages: [{
    role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'answer' }],
  }] } })
  await load
  assert.equal(useAppStore.getState().messages[0]?.id, 'existing')
  assert.equal(useAppStore.getState().messages[0]?.initiallyShowThinking, true)
})

test('a queued backfill cannot clear a new run that has already started', async () => {
  useAppStore.setState({ isStreaming: true, reattachedMidTurn: true })
  useAppStore.getState().handlePiEvent({ type: 'agent_end', messages: [] })
  useAppStore.getState().handlePiEvent({ type: 'agent_start' })
  stream('new run')
  await tick()
  assert.equal(historyRequests.length, 0)
  assert.equal(useAppStore.getState().streamingContent, 'new run')
  assert.equal(useAppStore.getState().isStreaming, true)
})

test('a stopped process commits visible output instead of leaving a permanent waiting indicator', () => {
  useAppStore.setState({ isStreaming: true })
  stream('partial response before exit')
  useAppStore.getState().handlePiEvent({ type: 'status_change', status: 'stopped', pid: null, error: null })
  assert.equal(useAppStore.getState().isStreaming, false)
  assert.equal(useAppStore.getState().messages[0]?.content, 'partial response before exit')
})

test('attaching after a tool started still displays its next progress update', () => {
  useAppStore.getState().handlePiEvent({
    type: 'tool_execution_update', toolCallId: 'ongoing', toolName: 'bash', args: { command: 'build' },
    partialResult: { content: [{ type: 'text', text: 'Building...' }], details: {} },
  })
  const state = useAppStore.getState()
  assert.equal(state.isStreaming, true)
  assert.equal(state.streamingToolCalls.get('ongoing')?.result, 'Building...')
  assert.equal(state.streamingToolCalls.get('ongoing')?.isExecuting, true)
})

test('reasoning stays expanded when its final message and agent_end arrive together', () => {
  useAppStore.setState({ isStreaming: true, streamingThinking: 'visible reasoning' })
  useAppStore.getState().handlePiEvent({
    type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'visible reasoning' }] },
  })
  useAppStore.getState().handlePiEvent({ type: 'agent_end', messages: [] })
  assert.equal(useAppStore.getState().messages[0]?.initiallyShowThinking, true)
})

test('a final response without deltas is displayed exactly once', () => {
  finish('complete response')
  useAppStore.getState().handlePiEvent({ type: 'turn_end', message: answer('complete response'), toolResults: [] })
  useAppStore.getState().handlePiEvent({ type: 'agent_end', messages: [answer('complete response')] })
  assert.deepEqual(useAppStore.getState().messages.map((message) => message.content), ['complete response'])
})

test('a new agent run makes subsequent streaming content visible without a local prompt', () => {
  useAppStore.getState().handlePiEvent({ type: 'agent_start' })
  stream('extension-triggered response')
  assert.equal(useAppStore.getState().isStreaming, true)
})
