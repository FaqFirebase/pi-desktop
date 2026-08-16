import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent } from '../../shared/ipc-contracts'
import { buildPlanningPrompt } from './utils/planning-prompt'

// sendPrompt/sendSteer reach the Pi process through the preload bridge; these
// stubs accept the calls so the echo bookkeeping under test can run.
const piDesktopStub = {
  pi: {
    getStatus: async () => ({ status: 'stopped' as const, pid: null, error: null }),
  },
  commands: {
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
  },
}

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  useAppStore.setState({
    piStatus: 'running',
    settings: null,
    isStreaming: false,
    messages: [],
    timelineEvents: [],
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
  })
})

function userMessageStart(content: string): PiRpcEvent {
  return { type: 'message_start', message: { role: 'user', content } } as PiRpcEvent
}

function userBubbles(): string[] {
  return useAppStore
    .getState()
    .messages.filter((m) => m.role === 'user')
    .map((m) => m.content)
}

function externalPromptEvents(): number {
  return useAppStore
    .getState()
    .timelineEvents.filter((e) => e.title === 'External prompt received').length
}

// A prompt injected inside the Pi process (e.g. pi-nvim's socket bridge) only
// reaches the GUI through the message_start echo. It must render.
test('external user message_start renders a bubble and timeline entry', () => {
  useAppStore.getState().handlePiEvent(userMessageStart('from nvim'))

  assert.deepEqual(userBubbles(), ['from nvim'])
  assert.equal(externalPromptEvents(), 1)
  assert.equal(useAppStore.getState().isStreaming, true)
})

test('assistant message_start renders nothing', () => {
  useAppStore.getState().handlePiEvent({
    type: 'message_start',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  } as PiRpcEvent)

  assert.deepEqual(useAppStore.getState().messages, [])
  assert.equal(externalPromptEvents(), 0)
})

test('whitespace-only external message renders nothing', () => {
  useAppStore.getState().handlePiEvent(userMessageStart('   '))

  assert.deepEqual(useAppStore.getState().messages, [])
  assert.equal(externalPromptEvents(), 0)
})

// The GUI's own prompt is rendered locally at send time; its echo on the
// event stream must be swallowed or every prompt would render twice.
test('own prompt echo is deduped', async () => {
  await useAppStore.getState().sendPrompt('hello there')
  useAppStore.getState().handlePiEvent(userMessageStart('hello there'))

  assert.deepEqual(userBubbles(), ['hello there'])
  assert.equal(externalPromptEvents(), 0)
})

// Plan mode sends a wrapped prompt but displays the raw text; the echo
// carries the wrapped form and must still be recognized as our own.
test('plan-mode prompt echo is deduped against the wrapped form', async () => {
  useAppStore.setState({
    settings: { permissionMode: 'plan-readonly' } as ReturnType<
      typeof useAppStore.getState
    >['settings'],
  })
  await useAppStore.getState().sendPrompt('plan this')
  useAppStore.getState().handlePiEvent(userMessageStart(buildPlanningPrompt('plan this')))

  assert.deepEqual(userBubbles(), ['plan this'])
  assert.equal(externalPromptEvents(), 0)
})

// Steering while a turn is streaming goes through commands.steer with the raw
// message text; its echo must be swallowed like a prompt echo.
test('steering prompt echo during streaming is deduped', async () => {
  useAppStore.setState({ isStreaming: true })
  await useAppStore.getState().sendPrompt('change course')
  useAppStore.getState().handlePiEvent(userMessageStart('change course'))

  assert.deepEqual(userBubbles(), ['change course'])
  assert.equal(externalPromptEvents(), 0)
})

// sendSteer/sendFollowUp never rendered bubbles; their echoes must not start
// rendering them as external prompts now.
test('sendSteer and sendFollowUp echoes render nothing', async () => {
  await useAppStore.getState().sendSteer('quiet steer')
  await useAppStore.getState().sendFollowUp('quiet follow-up')
  useAppStore.getState().handlePiEvent(userMessageStart('quiet steer'))
  useAppStore.getState().handlePiEvent(userMessageStart('quiet follow-up'))

  assert.deepEqual(useAppStore.getState().messages, [])
  assert.equal(externalPromptEvents(), 0)
})

// Each recorded echo covers exactly one message_start; a second identical
// message is a genuinely new (external) prompt and must render.
test('an echo is consumed once; a repeat of the same text renders', async () => {
  await useAppStore.getState().sendPrompt('same text')
  useAppStore.getState().handlePiEvent(userMessageStart('same text'))
  useAppStore.getState().handlePiEvent(userMessageStart('same text'))

  assert.deepEqual(userBubbles(), ['same text', 'same text'])
  assert.equal(externalPromptEvents(), 1)
})

// An external steer can land mid-turn; the live streaming buffers for the
// in-progress assistant response must survive it.
test('external prompt mid-stream preserves streaming state', () => {
  const toolCalls = new Map([['t1', { name: 'bash', args: '{}', isExecuting: true }]])
  useAppStore.setState({
    isStreaming: true,
    streamingContent: 'partial answer',
    streamingThinking: 'partial thought',
    streamingToolCalls: toolCalls,
  })

  useAppStore.getState().handlePiEvent(userMessageStart('injected mid-turn'))

  const state = useAppStore.getState()
  assert.deepEqual(userBubbles(), ['injected mid-turn'])
  assert.equal(state.streamingContent, 'partial answer')
  assert.equal(state.streamingThinking, 'partial thought')
  assert.equal(state.streamingToolCalls.size, 1)
})
