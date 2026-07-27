import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Each recorded call is appended to `calls`, so tests can assert both that a
// session change reached Pi and that nothing reached Pi when it was declined.
const calls: string[] = []
let switchResult: { success?: boolean; error?: string } | null = { success: true }

const SESSION_PATH = '/tmp/session-b.jsonl'
const FORK_ENTRY_ID = 'entry-7'

const WORKSPACE_ID = 'ws-2'

const piDesktopStub = {
  workspace: {
    setActive: async (id: string) => {
      calls.push(`setActiveWorkspace:${id}`)
      return { id, name: 'other', path: '/tmp/other', createdAt: 0, lastActiveAt: 0, color: '#000' }
    },
    list: async () => [],
  },
  pi: {
    getStatus: async () => ({ status: 'stopped' as const, pid: null, error: null }),
  },
  commands: {
    abort: async () => {
      calls.push('abort')
      return null
    },
  },
  session: {
    switch: async (path: string) => {
      calls.push(`switch:${path}`)
      return switchResult
    },
    createNew: async () => {
      calls.push('createNew')
      return { success: true }
    },
    fork: async (entryId: string) => {
      calls.push(`fork:${entryId}`)
      return { success: true }
    },
    clone: async () => {
      calls.push('clone')
      return { success: true }
    },
    getMessages: async () => {
      calls.push('getMessages')
      return { success: true, data: { messages: [] } }
    },
    getState: async () => ({ success: true, data: null }),
    getStats: async () => ({ success: true, data: null }),
    list: async () => [],
  },
}

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore

// The store reaches for `window.piDesktop` inside its actions, so the bridge has
// to exist before the module body runs — hence the deferred import.
before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore } = await import('./store'))
})

// A turn in flight: streaming flag set, partial buffers filled, and a queue
// update already applied — exactly the state a session change has to tear down.
function enterStreamingState(): void {
  useAppStore.setState({
    isStreaming: true,
    streamingContent: 'partial answer',
    streamingThinking: 'partial thinking',
    streamingToolCalls: new Map([
      ['call-1', { name: 'read', args: '{}', isExecuting: true }],
    ]),
    pendingSteering: ['steer me'],
    pendingFollowUp: ['follow up'],
    messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 0 }],
    promptHistory: ['hello'],
  })
}

// Answers the confirmation dialog the store raises while a turn is streaming.
// Resolving synchronously on the next microtask keeps the action under test
// awaiting a real promise, as it does against the rendered dialog.
function answerConfirm(confirmed: boolean): void {
  const poll = setInterval(() => {
    if (useAppStore.getState().confirmRequest) {
      clearInterval(poll)
      useAppStore.getState().resolveConfirm(confirmed)
    }
  }, 0)
  // Never leave the timer running if the dialog is not raised at all.
  setTimeout(() => clearInterval(poll), 100)
}

beforeEach(() => {
  calls.length = 0
  switchResult = { success: true }
  useAppStore.setState({
    isStreaming: false,
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
    pendingSteering: [],
    pendingFollowUp: [],
    messages: [],
    promptHistory: [],
    sessionState: null,
    confirmRequest: null,
  })
})

test('clearMessages resets every per-turn streaming field', () => {
  enterStreamingState()

  useAppStore.getState().clearMessages()

  const state = useAppStore.getState()
  assert.equal(state.isStreaming, false, 'isStreaming must not survive a chat reset')
  assert.equal(state.streamingContent, '')
  assert.equal(state.streamingThinking, '')
  assert.equal(state.streamingToolCalls.size, 0)
  assert.deepEqual(state.pendingSteering, [])
  assert.deepEqual(state.pendingFollowUp, [])
  assert.deepEqual(state.messages, [])
  assert.deepEqual(state.promptHistory, [])
})

test('confirmSessionChange passes straight through when no turn is streaming', async () => {
  const proceed = await useAppStore.getState().confirmSessionChange('switch')

  assert.equal(proceed, true)
  assert.equal(useAppStore.getState().confirmRequest, null, 'an idle Pi must not raise a dialog')
})

test('confirmSessionChange labels the dialog for the action being confirmed', async () => {
  enterStreamingState()

  const pending = useAppStore.getState().confirmSessionChange('fork')
  const request = useAppStore.getState().confirmRequest
  assert.ok(request, 'a streaming turn must raise the dialog')
  assert.equal(request.confirmLabel, 'Fork anyway')
  assert.equal(request.cancelLabel, 'Keep working')
  assert.match(request.message, /Forking this session/)
  assert.equal(request.danger, true, 'discarding a running turn must not be the default action')

  useAppStore.getState().resolveConfirm(false)
  assert.equal(await pending, false)
})

test('declining the warning leaves the streaming turn untouched', async () => {
  enterStreamingState()
  answerConfirm(false)

  await useAppStore.getState().switchSession(SESSION_PATH)

  const state = useAppStore.getState()
  assert.deepEqual(calls, [], 'a declined switch must not reach Pi at all')
  assert.equal(state.isStreaming, true, 'the running turn must survive a declined switch')
  assert.equal(state.streamingContent, 'partial answer')
  assert.deepEqual(state.pendingSteering, ['steer me'])
})

test('accepting the warning switches and clears the abandoned turn', async () => {
  enterStreamingState()
  answerConfirm(true)

  await useAppStore.getState().switchSession(SESSION_PATH)

  const state = useAppStore.getState()
  assert.equal(calls[0], `switch:${SESSION_PATH}`)
  assert.equal(state.isStreaming, false, 'the abandoned turn must not leave a stuck spinner')
  assert.equal(state.streamingContent, '')
  assert.deepEqual(state.pendingSteering, [], 'the old queue counters must not carry over')
})

test('switchSession does not warn when Pi is idle', async () => {
  await useAppStore.getState().switchSession(SESSION_PATH)

  assert.equal(useAppStore.getState().confirmRequest, null)
  assert.equal(calls[0], `switch:${SESSION_PATH}`)
})

test('switchSession clears streaming state even when Pi refuses the switch', async () => {
  enterStreamingState()
  answerConfirm(true)
  switchResult = { success: false, error: 'Pi not running. Start Pi first.' }

  await useAppStore.getState().switchSession(SESSION_PATH)

  const state = useAppStore.getState()
  assert.equal(state.isStreaming, false, 'a refused switch must still leave the composer usable')
  assert.equal(calls.includes('getMessages'), false, 'a refused switch must not reload history')
  assert.equal(
    state.messages.some((m) => m.role === 'system' && m.content.includes('Pi not running')),
    true,
    'the refusal reason must be shown to the user'
  )
})

test('createNewSession is gated by the same warning', async () => {
  enterStreamingState()
  answerConfirm(false)

  await useAppStore.getState().createNewSession()

  assert.deepEqual(calls, [], 'a declined new session must not reach Pi')
  assert.equal(useAppStore.getState().isStreaming, true)
})

test('forkFrom is gated by the same warning', async () => {
  enterStreamingState()
  answerConfirm(false)

  await useAppStore.getState().forkFrom(FORK_ENTRY_ID)

  assert.deepEqual(calls, [], 'a declined fork must not reach Pi')
  assert.equal(useAppStore.getState().isStreaming, true)
})

// Regression: the cross-workspace path in the sidebar and session panel switches
// workspace first, and that calls clearMessages() — which resets `isStreaming`,
// the very flag the session-change gate reads. The warning has to be raised by
// switchWorkspace itself, before anything clears state.
test('switchWorkspace warns before it clears the streaming flag', async () => {
  enterStreamingState()
  answerConfirm(false)

  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, false, 'a declined workspace switch must report failure to its caller')
  assert.deepEqual(calls, [], 'a declined workspace switch must not reach the main process')
  assert.equal(useAppStore.getState().isStreaming, true, 'the running turn must survive')
})

test('an accepted workspace switch leaves no stale streaming flag behind', async () => {
  enterStreamingState()
  answerConfirm(true)

  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, true)
  assert.equal(calls[0], `setActiveWorkspace:${WORKSPACE_ID}`)
  assert.equal(useAppStore.getState().isStreaming, false)
})

test('switchWorkspace does not warn when Pi is idle', async () => {
  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, true)
  assert.equal(useAppStore.getState().confirmRequest, null)
})

test('cloneBranch is gated by the same warning', async () => {
  enterStreamingState()
  answerConfirm(false)

  await useAppStore.getState().cloneBranch()

  assert.deepEqual(calls, [], 'a declined clone must not reach Pi')
  assert.equal(useAppStore.getState().isStreaming, true)
})
