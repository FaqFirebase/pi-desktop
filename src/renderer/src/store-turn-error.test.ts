import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent, Workspace } from '../../shared/ipc-contracts'

// Prompts and steers the store sent, in order, and the state reads it made.
const calls: string[] = []
const ACCEPTED = { type: 'response', command: 'prompt', success: true }
// What the stubbed engine answers to a prompt and to get_state.
let promptAnswer: () => Promise<unknown> = async () => ACCEPTED
let stateAnswer: () => Promise<unknown> = async () => ({ success: true, data: { isStreaming: false } })

const piDesktopStub = {
  pi: {
    getStatus: async () => ({ status: 'stopped' as const, pid: null, error: null }),
  },
  commands: {
    prompt: async (message: string) => {
      calls.push(`prompt:${message}`)
      return promptAnswer()
    },
    steer: async (message: string) => {
      calls.push(`steer:${message}`)
      return { type: 'response', command: 'steer', success: true }
    },
  },
  session: {
    getState: async () => {
      calls.push('getState')
      return stateAnswer()
    },
    getStats: async () => ({ success: true, data: null }),
    list: async () => [],
  },
}

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  calls.length = 0
  promptAnswer = async () => ACCEPTED
  stateAnswer = async () => ({ success: true, data: { isStreaming: false } })
  useAppStore.setState({
    messages: [],
    timelineEvents: [],
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
    isStreaming: false,
    piStatus: 'running',
    piEngine: 'pi',
    activeWorkspace: null,
  })
})

const PROVIDER_402_ERROR =
  '402: {"message":"this model uses extra usage only (not included plan usage)"}'

function erroredAssistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: PROVIDER_402_ERROR,
    ...overrides,
  }
}

function systemMessages(): string[] {
  return useAppStore
    .getState()
    .messages.filter((m) => m.role === 'system')
    .map((m) => m.content)
}

// A provider that rejects before streaming any tokens (e.g. an HTTP 402)
// produces an assistant message with stopReason 'error' and no content. The
// chat must surface that error instead of silently showing nothing.
test('message_end with stopReason error surfaces the error in chat', () => {
  useAppStore.getState().handlePiEvent({
    type: 'message_end',
    message: erroredAssistantMessage(),
  } as PiRpcEvent)

  assert.deepEqual(systemMessages(), [`Error: ${PROVIDER_402_ERROR}`])
})

test('message_end error without errorMessage falls back to a generic label', () => {
  useAppStore.getState().handlePiEvent({
    type: 'message_end',
    message: erroredAssistantMessage({ errorMessage: undefined }),
  } as PiRpcEvent)

  assert.deepEqual(systemMessages(), ['Error: Unknown error'])
})

// turn_end re-delivers the same errored message right after message_end; only
// one of the two may surface it or every failure would render twice.
test('turn_end with the same errored message does not duplicate the error', () => {
  const message = erroredAssistantMessage()
  useAppStore.getState().handlePiEvent({ type: 'message_end', message } as PiRpcEvent)
  useAppStore
    .getState()
    .handlePiEvent({ type: 'turn_end', message, toolResults: [] } as PiRpcEvent)

  assert.equal(systemMessages().length, 1)
})

test('message_end with a normal stop reason adds no error message', () => {
  useAppStore.getState().handlePiEvent({
    type: 'message_end',
    message: erroredAssistantMessage({ stopReason: 'stop', errorMessage: undefined }),
  } as PiRpcEvent)

  assert.deepEqual(systemMessages(), [])
})

// A plain user-initiated abort is already visible in the UI; repeating the
// generic abort text as an error would be noise. A specific abort reason
// (e.g. an extension killed the turn with an explanation) is worth showing.
test('aborted turn surfaces only a non-generic abort reason', () => {
  useAppStore.getState().handlePiEvent({
    type: 'message_end',
    message: erroredAssistantMessage({
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
    }),
  } as PiRpcEvent)
  assert.deepEqual(systemMessages(), [])

  useAppStore.getState().handlePiEvent({
    type: 'message_end',
    message: erroredAssistantMessage({
      stopReason: 'aborted',
      errorMessage: 'Aborted by permission extension',
    }),
  } as PiRpcEvent)
  assert.deepEqual(systemMessages(), ['Error: Aborted by permission extension'])
})

test('a user stop on OMP reads as a plain stop, not an error', () => {
  useAppStore.getState().handlePiEvent({
    type: 'message_end',
    message: erroredAssistantMessage({
      stopReason: 'aborted',
      errorMessage: 'Interrupted by user',
      content: [{ type: 'text', text: 'Partial answer' }],
    }),
  } as PiRpcEvent)
  assert.deepEqual(systemMessages(), [])
})

test('message_end for a non-assistant message adds no error message', () => {
  useAppStore.getState().handlePiEvent({
    type: 'message_end',
    message: { role: 'user', content: 'hello', stopReason: 'error' },
  } as PiRpcEvent)

  assert.deepEqual(systemMessages(), [])
})

// The timeline entry for a failed response must not claim success.
test('message_end with stopReason error records a failed timeline event', () => {
  useAppStore.getState().handlePiEvent({
    type: 'message_end',
    message: erroredAssistantMessage(),
  } as PiRpcEvent)

  const events = useAppStore.getState().timelineEvents
  const failure = events.find((e) => e.type === 'assistant_message')
  assert.ok(failure, 'expected an assistant_message timeline event')
  assert.equal(failure.status, 'error')
})

test('an OMP local command answered in the prompt response ends the wait for a turn', async () => {
  promptAnswer = async () => ({ ...ACCEPTED, data: { agentInvoked: false } })

  await useAppStore.getState().sendPrompt('/context')

  assert.equal(useAppStore.getState().isStreaming, false)
  assert.deepEqual(systemMessages(), [])
})

// ─── Prompts that run no turn ────────────────────────────────────────────────

const NO_KEY = 'No API key found for anthropic.'

function refused(error?: string): Record<string, unknown> {
  return { type: 'response', command: 'prompt', success: false, ...(error === undefined ? {} : { error }) }
}

function promptResultError(message: string): PiRpcEvent {
  return { type: 'prompt_result', agentInvoked: false, status: 'error', error: { message } } as PiRpcEvent
}

function sentAs(): string[] {
  return calls.filter((call) => call.startsWith('prompt:') || call.startsWith('steer:'))
}

// Pi answers a failed preflight (no API key, an expired login, no model) with
// success: false and runs no turn, so no agent_end ever closes the stream.
test('a prompt the engine refuses ends the turn and says why', async () => {
  promptAnswer = async () => refused(NO_KEY)

  await useAppStore.getState().sendPrompt('hello')

  assert.equal(useAppStore.getState().isStreaming, false)
  assert.deepEqual(systemMessages(), [`Error: ${NO_KEY}`])
  await useAppStore.getState().sendPrompt('hello again')
  assert.deepEqual(sentAs(), ['prompt:hello', 'prompt:hello again'], 'the next message must not go out as a steer')
})

test('a refusal without a reason still ends the turn', async () => {
  promptAnswer = async () => refused()

  await useAppStore.getState().sendPrompt('hello')

  assert.equal(useAppStore.getState().isStreaming, false)
  assert.deepEqual(systemMessages(), ['Error: Unknown error'])
})

// Pi runs an extension command, or lets an input handler take the prompt,
// before it answers: success, and no agent_start or agent_end follows.
test('an accepted prompt that runs no turn ends the wait for one', async () => {
  await useAppStore.getState().sendPrompt('/status')

  assert.equal(useAppStore.getState().isStreaming, false)
  assert.deepEqual(systemMessages(), [])
})

test('an accepted prompt whose turn runs keeps streaming', async () => {
  stateAnswer = async () => ({ success: true, data: { isStreaming: true } })

  await useAppStore.getState().sendPrompt('hello')

  assert.equal(useAppStore.getState().isStreaming, true)
})

test('a turn that started before the answer is left to its own agent_end', async () => {
  promptAnswer = async () => {
    useAppStore.getState().handlePiEvent({ type: 'agent_start' })
    return ACCEPTED
  }

  await useAppStore.getState().sendPrompt('/review')

  assert.equal(useAppStore.getState().isStreaming, true, 'a state read that says idle must not end a turn that ran')
  useAppStore.getState().handlePiEvent({ type: 'agent_end', messages: [] })
  assert.equal(useAppStore.getState().isStreaming, false)
})

test('a turn that starts while the state is read is not ended by the read', async () => {
  // agent_start reads the state again; the turn starts during the first read.
  let reads = 0
  stateAnswer = async () => {
    reads += 1
    if (reads === 1) useAppStore.getState().handlePiEvent({ type: 'agent_start' })
    return { success: true, data: { isStreaming: false } }
  }

  await useAppStore.getState().sendPrompt('/review')

  assert.equal(useAppStore.getState().isStreaming, true)
})

test('an unreadable state leaves the turn to the engine events', async () => {
  stateAnswer = async () => null

  await useAppStore.getState().sendPrompt('hello')

  assert.equal(useAppStore.getState().isStreaming, true)
})

test('an answer that arrives after the user left the chat leaves the new chat alone', async () => {
  const before: Workspace = { id: 'ws-a', name: 'a', path: '/tmp/a', createdAt: 0, lastActiveAt: 0, color: '#000' }
  useAppStore.setState({ activeWorkspace: before })
  let answer!: (response: unknown) => void
  promptAnswer = () => new Promise((resolve) => { answer = resolve })

  const sending = useAppStore.getState().sendPrompt('hello')
  // The user opened another project, whose turn is running.
  useAppStore.setState({ activeWorkspace: { ...before, id: 'ws-b' }, messages: [], isStreaming: true })
  answer(refused(NO_KEY))
  await sending

  assert.equal(useAppStore.getState().isStreaming, true)
  assert.deepEqual(systemMessages(), [])
})

// OMP answers a prompt when it admits it and reports how the prompt ended in
// a prompt_result event: a model or API key check that fails after admission,
// or an extension command that runs after the answer.
const OMP_COMMAND_FINISHED = { type: 'prompt_result', agentInvoked: false, status: 'completed' } as PiRpcEvent

test('an OMP prompt refused after admission ends the turn when its prompt_result says why', async () => {
  useAppStore.setState({ piEngine: 'omp' })

  await useAppStore.getState().sendPrompt('hello')
  assert.equal(useAppStore.getState().isStreaming, true, 'admitted: the outcome comes later')
  useAppStore.getState().handlePiEvent(promptResultError(NO_KEY))

  assert.equal(useAppStore.getState().isStreaming, false)
  assert.deepEqual(systemMessages(), [`Error: ${NO_KEY}`])
})

test('an OMP extension command keeps the turn open until its prompt_result, with no state read', async () => {
  useAppStore.setState({ piEngine: 'omp' })

  await useAppStore.getState().sendPrompt('/review')

  assert.equal(useAppStore.getState().isStreaming, true, 'the command still runs after OMP answered')
  assert.equal(calls.includes('getState'), false, 'OMP idles while a command runs, so a state read would end it early')
  useAppStore.getState().handlePiEvent(OMP_COMMAND_FINISHED)
  assert.equal(useAppStore.getState().isStreaming, false)
  assert.deepEqual(systemMessages(), [])
})

// The user stopped the command and sent a new prompt, whose turn is running
// when the command's own report comes in.
test('a late OMP prompt_result for an earlier prompt leaves a newer turn alone', async () => {
  useAppStore.setState({ piEngine: 'omp' })
  await useAppStore.getState().sendPrompt('/review')
  useAppStore.setState({ isStreaming: false })
  await useAppStore.getState().sendPrompt('hello')
  useAppStore.getState().handlePiEvent({ type: 'agent_start' })
  useAppStore.setState({ streamingContent: 'partial answer' })

  useAppStore.getState().handlePiEvent(OMP_COMMAND_FINISHED)

  assert.equal(useAppStore.getState().isStreaming, true)
  assert.equal(useAppStore.getState().streamingContent, 'partial answer')
})

// OMP reports one refusal twice, as an error response and as a prompt_result,
// in either order.
test('an OMP refusal reported twice shows its reason once, in either order', async () => {
  promptAnswer = async () => refused(NO_KEY)
  await useAppStore.getState().sendPrompt('hello')
  useAppStore.getState().handlePiEvent(promptResultError(NO_KEY))
  assert.deepEqual(systemMessages(), [`Error: ${NO_KEY}`])

  useAppStore.setState({ messages: [] })
  promptAnswer = async () => {
    useAppStore.getState().handlePiEvent(promptResultError(NO_KEY))
    return refused(NO_KEY)
  }
  await useAppStore.getState().sendPrompt('hello')
  assert.deepEqual(systemMessages(), [`Error: ${NO_KEY}`])
})
