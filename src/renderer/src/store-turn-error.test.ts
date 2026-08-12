import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent } from '../../shared/ipc-contracts'

// The store only touches window.piDesktop inside actions these tests don't
// exercise, but the bridge must exist before the module body runs.
const piDesktopStub = {
  pi: {
    getStatus: async () => ({ status: 'stopped' as const, pid: null, error: null }),
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
    messages: [],
    timelineEvents: [],
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
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
