import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiExtensionUiRequest, SessionListItem, SessionRuntimeInfo, SessionState, Workspace } from '../../shared/ipc-contracts'
import type { PreviewTarget } from './store'

// Each recorded call is appended to `calls`, so tests can assert both that a
// session change reached Pi and that nothing reached Pi when it was declined.
const calls: string[] = []
let switchResult: { success?: boolean; error?: string } | SessionRuntimeInfo | null = { success: true }
// Non-null makes the stubbed pi.getStatus reject, simulating a main-side
// failure AFTER a workspace switch has already committed.
let getStatusFailure: string | null = null
// Status the stubbed pi.getStatus reports for the ACTIVE workspace. A live
// background turn means the target workspace's own process is running.
let piStatusResult: 'stopped' | 'running' = 'stopped'
// Non-null makes the stubbed workspace.setActive reject, simulating a switch
// that never commits on the main side.
let setActiveFailure: string | null = null
// Non-null makes the stubbed ui.getPendingPrompts reject, simulating a boot
// recovery that cannot reach main.
let pendingPromptsFailure: string | null = null
let pendingPromptsSnapshot: Record<string, number> = {}
// Non-null makes the stubbed workspace.getActivity reject; the activity
// snapshot is cosmetic and must never block prompt recovery.
let workspaceActivityFailure: string | null = null
let workspaceActivitySnapshot: Record<string, { state: 'working' | 'needs-approval' | 'completed' | 'failed'; since: number }> = {}
let activeWorkspaceResult: Workspace | null = null
let workspaceListResult: Workspace[] = []
// Results the stubbed files.search returns; the hook runs while the "IPC" is
// in flight so tests can interleave state changes with the await.
let fileSearchResults: Array<{
  name: string
  path: string
  relativePath: string
  matchType: string
}> = []
let fileSearchHook: (() => void) | null = null
// What the stubbed session.getState returns as data (null = no state).
let sessionStateResult: SessionState | null = null

// Only sessionFile is read by the code under test; the cast keeps this
// fixture from churning as SessionState grows fields.
function sessionStateWith(sessionFile: string): SessionState {
  return { sessionFile } as unknown as SessionState
}

const SESSION_PATH = '/tmp/session-b.jsonl'
const FORK_ENTRY_ID = 'entry-7'

const WORKSPACE_ID = 'ws-2'

const WORKSPACE_ONE: Workspace = {
  id: 'ws-1',
  name: 'one',
  path: '/tmp/one',
  createdAt: 0,
  lastActiveAt: 0,
  color: '#000',
}

const WORKSPACE_TWO: Workspace = {
  id: WORKSPACE_ID,
  name: 'two',
  path: '/tmp/two',
  createdAt: 0,
  lastActiveAt: 0,
  color: '#000',
}

const EXTENSION_DIALOG: PiExtensionUiRequest = {
  type: 'extension_ui_request',
  id: 'req-dialog',
  method: 'confirm',
  title: 'Allow write?',
}

const EXTENSION_NOTIFY: PiExtensionUiRequest = {
  type: 'extension_ui_request',
  id: 'req-notify',
  method: 'notify',
  message: 'build finished',
}

const piDesktopStub = {
  workspace: {
    setActive: async (id: string) => {
      if (setActiveFailure) throw new Error(setActiveFailure)
      calls.push(`setActiveWorkspace:${id}`)
      const hit = workspaceListResult.find((w) => w.id === id)
      if (hit) activeWorkspaceResult = hit
      return hit ?? { id, name: 'other', path: '/tmp/other', createdAt: 0, lastActiveAt: 0, color: '#000' }
    },
    list: async () => workspaceListResult,
    getActive: async () => activeWorkspaceResult,
    getActivity: async () => {
      if (workspaceActivityFailure) throw new Error(workspaceActivityFailure)
      return workspaceActivitySnapshot
    },
    create: async (name: string, path: string) => {
      calls.push(`createWorkspace:${name}:${path}`)
      // Mirror main: existing path activates that workspace.
      const existing = workspaceListResult.find((w) => w.path === path)
      if (existing) {
        activeWorkspaceResult = existing
        return existing
      }
      // Tests that pre-set getActive for create→activate without a prior list.
      if (activeWorkspaceResult && activeWorkspaceResult.path === path) {
        return activeWorkspaceResult
      }
      const created = {
        id: `ws-new-${name}`,
        name,
        path,
        createdAt: 0,
        lastActiveAt: 0,
        color: '#000',
      }
      workspaceListResult = [...workspaceListResult, created]
      // First workspace becomes active; otherwise leave active alone.
      if (!activeWorkspaceResult) activeWorkspaceResult = created
      return created
    },
    remove: async (id: string) => {
      calls.push(`removeWorkspace:${id}`)
    },
    changePath: async (id: string, path: string) => {
      calls.push(`changePath:${id}:${path}`)
    },
  },
  system: {
    pathKind: async (filePath: string) => {
      calls.push(`pathKind:${filePath}`)
      return { exists: true, isDirectory: true }
    },
  },
  files: {
    search: async (query: string) => {
      calls.push(`filesSearch:${query}`)
      fileSearchHook?.()
      return fileSearchResults
    },
  },
  pi: {
    getStatus: async () => {
      if (getStatusFailure) throw new Error(getStatusFailure)
      return { status: piStatusResult, pid: piStatusResult === 'running' ? 1 : null, error: null }
    },
    start: async () => {
      calls.push('pi.start')
      return { status: 'running' as const, pid: 1, error: null }
    },
    restart: async () => {
      calls.push('pi.restart')
      return { status: 'running' as const, pid: 1, error: null }
    },
  },
  ui: {
    respondSelect: (id: string, _value: string) => {
      calls.push(`respondSelect:${id}`)
    },
    respondConfirm: (id: string, _confirmed: boolean) => {
      calls.push(`respondConfirm:${id}`)
    },
    respondInput: (id: string, _value: string) => {
      calls.push(`respondInput:${id}`)
    },
    respondEditor: (id: string, _value: string) => {
      calls.push(`respondEditor:${id}`)
    },
    flushPendingPrompts: async (workspaceId: string) => {
      calls.push(`flushPendingPrompts:${workspaceId}`)
    },
    getPendingPrompts: async () => {
      if (pendingPromptsFailure) throw new Error(pendingPromptsFailure)
      return pendingPromptsSnapshot
    },
    setEditorDirty: (dirty: boolean, fileName: string | null) => {
      calls.push(`editorDirtyMirror:${dirty}:${fileName ?? ''}`)
    },
  },
  commands: {
    abort: async () => {
      calls.push('abort')
      return null
    },
    prompt: async (message: string) => {
      calls.push(`prompt:${message}`)
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
    closeRuntime: async (runtimeId: string) => {
      calls.push(`closeRuntime:${runtimeId}`)
      return { runtimeId, workspaceId: WORKSPACE_ONE.id, sessionPath: SESSION_PATH, empty: false, deleted: false }
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
    getState: async () => ({ success: true, data: sessionStateResult }),
    getStats: async () => ({ success: true, data: null }),
    list: async () => [],
  },
}

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore
let countPromptsWaitingElsewhere: typeof import('./store')['countPromptsWaitingElsewhere']
let formatPromptsWaiting: typeof import('./store')['formatPromptsWaiting']
let openFileFromChat: typeof import('./components/chat-file-link')['openFileFromChat']
let DIALOG_OVERLAY_Z_INDEX: number
let NOTIFY_TOAST_Z_INDEX: number

// The store reaches for `window.piDesktop` inside its actions, so the bridge has
// to exist before the module body runs — hence the deferred import.
before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore, countPromptsWaitingElsewhere, formatPromptsWaiting } = await import('./store'))
  ;({ openFileFromChat } = await import('./components/chat-file-link'))
  ;({ DIALOG_OVERLAY_Z_INDEX, NOTIFY_TOAST_Z_INDEX } = await import('./components/extension-ui-dialog'))
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

// Answers confirmation dialogs the store raises, in order. Polling keeps the
// action under test awaiting a real promise, as it does against the rendered
// dialog; a single poller answers each dialog as it appears. Arming cancels
// any previous poller — a stray from a test whose dialogs never appeared must
// not answer a later test's dialog with the wrong value.
let answerPoll: ReturnType<typeof setInterval> | null = null

function answerConfirms(values: boolean[]): void {
  if (answerPoll !== null) clearInterval(answerPoll)
  let next = 0
  const poll = setInterval(() => {
    if (next >= values.length) {
      clearInterval(poll)
      return
    }
    if (useAppStore.getState().confirmRequest) {
      useAppStore.getState().resolveConfirm(values[next])
      next++
    }
  }, 0)
  answerPoll = poll
  // Never leave the timer running if the dialogs are not raised at all.
  setTimeout(() => clearInterval(poll), 100)
}

function answerConfirm(confirmed: boolean): void {
  answerConfirms([confirmed])
}

beforeEach(() => {
  if (answerPoll !== null) {
    clearInterval(answerPoll)
    answerPoll = null
  }
  switchResult = { success: true }
  getStatusFailure = null
  piStatusResult = 'stopped'
  setActiveFailure = null
  pendingPromptsSnapshot = {}
  workspaceActivityFailure = null
  workspaceActivitySnapshot = {}
  activeWorkspaceResult = null
  workspaceListResult = []
  fileSearchResults = []
  fileSearchHook = null
  sessionStateResult = null
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
    extensionUiRequest: null,
    extensionNotify: null,
    pendingPromptCounts: {},
    workspaceActivity: {},
    reattachedMidTurn: false,
    sessionLoading: false,
    activeSessionRuntimeId: null,
    activeWorkspace: null,
    workspaces: [],
    piStatus: 'stopped',
    currentView: 'home',
    previewTarget: null,
    chatSidePanel: null,
    editorDirty: false,
  })
  // AFTER the state reset: the editor-dirty mirror subscription fires on the
  // reset itself when the previous test left the flag set, and that push
  // belongs to cleanup, not to the test about to run.
  calls.length = 0
})

test('a ready new runtime hydrates while the empty session is still loading', async () => {
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE],
    activeSessionRuntimeId: 'rt-new',
    sessionLoading: true,
    sessionState: null,
    messages: [],
  })

  const runtime: SessionRuntimeInfo = {
    runtimeId: 'rt-new',
    workspaceId: WORKSPACE_ONE.id,
    sessionPath: SESSION_PATH,
    sessionId: 'session-new',
    status: 'running',
    pid: 123,
    error: null,
    activity: null,
    active: true,
  }
  useAppStore.getState().handleSessionRuntime(runtime)
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(calls.includes('getMessages'), true)
  assert.equal(useAppStore.getState().sessionLoading, false)
})

test('an active runtime error ends the session loading state', () => {
  useAppStore.setState({
    activeSessionRuntimeId: 'rt-failed',
    sessionLoading: true,
  })

  useAppStore.getState().handleSessionRuntime({
    runtimeId: 'rt-failed',
    workspaceId: WORKSPACE_ONE.id,
    sessionPath: null,
    sessionId: null,
    status: 'error',
    pid: null,
    error: 'Pi failed to start',
    activity: 'failed',
    active: true,
  })

  assert.equal(useAppStore.getState().sessionLoading, false)
  assert.equal(useAppStore.getState().piError, 'Pi failed to start')
})

test('closed runtime events remove session tabs from renderer state', () => {
  useAppStore.setState({
    sessionRuntimes: {
      'rt-closed': {
        runtimeId: 'rt-closed',
        workspaceId: WORKSPACE_ONE.id,
        sessionPath: SESSION_PATH,
        sessionId: 'closed-session',
        status: 'stopped',
        pid: null,
        error: null,
        activity: null,
        active: true,
      },
    },
    activeSessionRuntimeId: 'rt-closed',
  })

  useAppStore.getState().handleSessionRuntime({
    runtimeId: 'rt-closed',
    workspaceId: WORKSPACE_ONE.id,
    sessionPath: SESSION_PATH,
    sessionId: 'closed-session',
    status: 'stopped',
    pid: null,
    error: null,
    activity: null,
    active: false,
    closed: true,
  })

  assert.equal(useAppStore.getState().sessionRuntimes['rt-closed'], undefined)
  assert.equal(useAppStore.getState().activeSessionRuntimeId, null)
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

test('switching sessions does not warn or stop the previous process', async () => {
  enterStreamingState()

  await useAppStore.getState().switchSession(SESSION_PATH)

  const state = useAppStore.getState()
  assert.equal(calls.includes(`switch:${SESSION_PATH}`), true)
  assert.equal(state.isStreaming, false, 'the newly selected session starts with a clean local stream')
  assert.equal(state.streamingContent, '')
  assert.deepEqual(state.pendingSteering, [])
})

test('switching sessions clears the local streaming state', async () => {
  enterStreamingState()
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

test('createNewSession starts an independent runtime without warning', async () => {
  enterStreamingState()

  await useAppStore.getState().createNewSession()

  assert.equal(calls.includes('createNew'), true)
  assert.equal(useAppStore.getState().isStreaming, false)
})

test('createNewSession opens the new conversation in Chat', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  workspaceListResult = [WORKSPACE_ONE]
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE],
    currentView: 'sessions',
  })

  await useAppStore.getState().createNewSession()

  const state = useAppStore.getState()
  assert.equal(calls.includes('createNew'), true)
  assert.equal(state.currentView, 'chat')
  assert.equal(state.sessionLoading, false, 'an empty new session should render immediately')
})

test('forkFrom is gated by the same warning', async () => {
  enterStreamingState()
  answerConfirm(false)

  await useAppStore.getState().forkFrom(FORK_ENTRY_ID)

  assert.deepEqual(calls, [], 'a declined fork must not reach Pi')
  assert.equal(useAppStore.getState().isStreaming, true)
})

// Workspace switches are safe because each workspace owns a separate Pi
// process. Switching tabs must not block on, abort, or warn about the turn that
// remains active in the background.
test('switchWorkspace leaves a running Pi in the background without warning', async () => {
  enterStreamingState()

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

// ─── Cross-workspace extension-UI prompts (queue-and-replay) ─────────────────

test('an accepted workspace switch clears the held dialog without answering it', async () => {
  useAppStore.setState({ extensionUiRequest: EXTENSION_DIALOG })

  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, true)
  assert.equal(useAppStore.getState().extensionUiRequest, null, 'the old workspace dialog must leave the screen')
  assert.equal(
    calls.some((c) => c.startsWith('respond')),
    false,
    'clearing the slot must not synthesize an answer — a false deny hard-blocks the asking tool'
  )
})

test('a workspace switch clears the old dialog without answering it', async () => {
  useAppStore.setState({ extensionUiRequest: EXTENSION_DIALOG })

  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, true)
  assert.equal(useAppStore.getState().extensionUiRequest, null)
  assert.equal(calls.includes(`flushPendingPrompts:${WORKSPACE_ID}`), true)
  assert.equal(
    calls.some((c) => c.startsWith('respond')),
    false,
    'switching tabs must not synthesize a deny for the background prompt'
  )
})

test('a successful workspace switch flushes prompts for the new workspace', async () => {
  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, true)
  assert.equal(calls.includes(`flushPendingPrompts:${WORKSPACE_ID}`), true)
})

// Design invariant: the dialog slot may only be cleared once setActive has
// committed. Clearing it earlier loses the prompt from the screen of a
// workspace the user never actually left.
test('a failed setActive keeps the dialog on screen and replays nothing', async () => {
  setActiveFailure = 'workspace backend gone'
  useAppStore.setState({ extensionUiRequest: EXTENSION_DIALOG })

  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, false, 'a switch that never committed must report failure')
  assert.equal(
    useAppStore.getState().extensionUiRequest?.id,
    EXTENSION_DIALOG.id,
    'the dialog still belongs to the workspace on screen'
  )
  assert.equal(
    calls.some((c) => c.startsWith('flushPendingPrompts')),
    false,
    'nothing may be replayed for a workspace that never became active'
  )
})

test('the flush still runs when a step after the committed switch rejects', async () => {
  getStatusFailure = 'status backend gone'

  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, false, 'the caller must learn the chain failed')
  assert.equal(calls.includes(`setActiveWorkspace:${WORKSPACE_ID}`), true)
  assert.equal(
    calls.includes(`flushPendingPrompts:${WORKSPACE_ID}`),
    true,
    'the switch committed on the main side, so the held prompt must still be replayed'
  )
})

test('notify and dialog requests occupy separate slots in either order', () => {
  useAppStore.getState().handlePiEvent(EXTENSION_DIALOG)
  useAppStore.getState().handlePiEvent(EXTENSION_NOTIFY)

  let state = useAppStore.getState()
  assert.equal(state.extensionUiRequest?.id, EXTENSION_DIALOG.id, 'a toast must never clobber a blocking dialog')
  assert.equal(state.extensionNotify?.id, EXTENSION_NOTIFY.id)

  useAppStore.setState({ extensionUiRequest: null, extensionNotify: null })
  useAppStore.getState().handlePiEvent(EXTENSION_NOTIFY)
  useAppStore.getState().handlePiEvent(EXTENSION_DIALOG)

  state = useAppStore.getState()
  assert.equal(state.extensionNotify?.id, EXTENSION_NOTIFY.id, 'a dialog must never clobber a toast')
  assert.equal(state.extensionUiRequest?.id, EXTENSION_DIALOG.id)
})

test('dismissing a notify toast answers it and leaves the dialog slot alone', () => {
  useAppStore.setState({ extensionUiRequest: EXTENSION_DIALOG, extensionNotify: EXTENSION_NOTIFY })

  useAppStore.getState().dismissExtensionNotify()

  const state = useAppStore.getState()
  assert.equal(state.extensionNotify, null)
  assert.equal(state.extensionUiRequest?.id, EXTENSION_DIALOG.id)
  assert.deepEqual(
    calls,
    [`respondInput:${EXTENSION_NOTIFY.id}`],
    'toast dismissal keeps sending the empty-input response Pi ignores'
  )
})

test('pending prompt counts land in state and sum over non-active workspaces', () => {
  useAppStore.getState().handlePendingPromptCounts({ 'ws-2': 2, 'ws-9': 1 })

  assert.deepEqual(useAppStore.getState().pendingPromptCounts, { 'ws-2': 2, 'ws-9': 1 })
  assert.equal(countPromptsWaitingElsewhere({ 'ws-2': 2, 'ws-9': 1 }, 'ws-2'), 1)
  assert.equal(countPromptsWaitingElsewhere({ 'ws-2': 2, 'ws-9': 1 }, null), 3)
  assert.equal(formatPromptsWaiting(1), '1 Pi prompt waiting')
  assert.equal(formatPromptsWaiting(3), '3 Pi prompts waiting')
})

test('removing the workspace flushes prompts only when a new one is promoted', async () => {
  useAppStore.setState({ activeWorkspace: WORKSPACE_ONE, extensionUiRequest: EXTENSION_DIALOG })
  activeWorkspaceResult = WORKSPACE_TWO
  answerConfirm(true)

  await useAppStore.getState().removeWorkspace(WORKSPACE_ONE.id)

  assert.equal(
    calls.includes(`flushPendingPrompts:${WORKSPACE_ID}`),
    true,
    'the promoted workspace may hold a prompt that must surface now'
  )
  assert.equal(
    useAppStore.getState().extensionUiRequest,
    null,
    'the dialog belonged to the workspace that is gone'
  )
  assert.equal(
    calls.some((c) => c.startsWith('respond')),
    false,
    'clearing the slot must not synthesize an answer'
  )

  calls.length = 0
  useAppStore.setState({ activeWorkspace: activeWorkspaceResult, extensionUiRequest: EXTENSION_DIALOG })
  answerConfirm(true)
  await useAppStore.getState().removeWorkspace('ws-9')

  assert.equal(
    calls.some((c) => c.startsWith('flushPendingPrompts')),
    false,
    'removing a non-active workspace changes nothing on screen'
  )
  assert.equal(
    useAppStore.getState().extensionUiRequest?.id,
    EXTENSION_DIALOG.id,
    'the active workspace keeps its unanswered dialog'
  )
})

// Regression: main activates the existing workspace when a create names a path
// it already knows (and when it creates the very first workspace). The renderer
// never routed that through switchWorkspace, so without adopting the change the
// newly-active workspace's held prompt stays invisible — the badge hides it
// (it counts other workspaces only) and no dialog is ever broadcast.
test('a create that main turns into an activation adopts the new workspace', async () => {
  useAppStore.setState({ activeWorkspace: WORKSPACE_ONE, extensionUiRequest: EXTENSION_DIALOG })
  activeWorkspaceResult = WORKSPACE_TWO

  await useAppStore.getState().createWorkspace(WORKSPACE_TWO.name, WORKSPACE_TWO.path)

  assert.equal(calls.includes(`createWorkspace:${WORKSPACE_TWO.name}:${WORKSPACE_TWO.path}`), true)
  assert.equal(
    useAppStore.getState().extensionUiRequest,
    null,
    'the dialog belongs to the workspace that just left the screen'
  )
  assert.equal(
    calls.some((c) => c.startsWith('respond')),
    false,
    'clearing the slot must not synthesize an answer — a false deny hard-blocks the asking tool'
  )
  assert.equal(
    calls.includes(`flushPendingPrompts:${WORKSPACE_TWO.id}`),
    true,
    'a prompt held for the workspace now on screen must be replayed'
  )
})

test('a create that leaves the active workspace alone touches neither slot nor prompts', async () => {
  useAppStore.setState({ activeWorkspace: WORKSPACE_ONE, extensionUiRequest: EXTENSION_DIALOG })
  activeWorkspaceResult = WORKSPACE_ONE
  // New path while one is already active — main does not switch away.
  workspaceListResult = [WORKSPACE_ONE]

  await useAppStore.getState().createWorkspace(WORKSPACE_TWO.name, WORKSPACE_TWO.path)

  assert.equal(useAppStore.getState().extensionUiRequest?.id, EXTENSION_DIALOG.id)
  assert.equal(
    calls.some((c) => c.startsWith('flushPendingPrompts')),
    false,
    'the workspace on screen did not change, so nothing needs replaying'
  )
})

// Regression: openFolderAsWorkspace must not treat "main activated the target on
// create" as "we were already on that workspace". Skipping switchWorkspace leaves
// the previous chat/messages on screen.
test('openFolderAsWorkspace switches when the dropped folder is an existing other workspace', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    messages: [{ id: 'old', role: 'user', content: 'from workspace one', timestamp: 0 }],
    piStatus: 'running',
    currentView: 'home',
  })

  const ok = await useAppStore.getState().openFolderAsWorkspace(WORKSPACE_TWO.path)

  assert.equal(ok, true)
  assert.equal(
    calls.includes(`setActiveWorkspace:${WORKSPACE_TWO.id}`),
    true,
    'must route through switchWorkspace so messages and Pi status resync'
  )
  assert.deepEqual(
    useAppStore.getState().messages,
    [],
    'previous workspace chat must clear on switch'
  )
  assert.equal(useAppStore.getState().currentView, 'chat')
  assert.equal(
    useAppStore.getState().piStatus,
    'stopped',
    'an idle target shows the empty view instantly — no process is spawned'
  )
  assert.equal(
    calls.includes('pi.start'),
    false,
    'navigation must not spawn a process'
  )
})

test('activating an idle workspace shows the empty view without starting Pi', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    messages: [{ id: 'old', role: 'user', content: 'old chat', timestamp: 0 }],
    piStatus: 'running',
  })

  const ok = await useAppStore.getState().switchWorkspace(WORKSPACE_TWO.id)

  assert.equal(ok, true)
  const state = useAppStore.getState()
  assert.equal(calls.includes('pi.start'), false, 'selection must stay process-free')
  assert.equal(state.activeWorkspace?.id, WORKSPACE_TWO.id)
  assert.deepEqual(state.messages, [])
  assert.equal(state.sessionLoading, false, 'no spinner without a process')
  assert.equal(state.sessionState, null)
  assert.equal(state.piStatus, 'stopped')
})

test('the first prompt lazy-starts an idle workspace', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
  })
  await useAppStore.getState().switchWorkspace(WORKSPACE_TWO.id)
  calls.length = 0

  await useAppStore.getState().sendPrompt('ship it')

  const startAt = calls.indexOf('pi.start')
  assert.notEqual(startAt, -1, 'the first send must spawn the agent')
  assert.equal(
    calls.findIndex((c) => c.startsWith('prompt:')),
    startAt + 1,
    'the prompt goes out only after startup completes'
  )
  assert.equal(useAppStore.getState().piStatus, 'running')
})

test('openFolderAsWorkspace skips switch when the dropped folder is already active', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_TWO
  useAppStore.setState({
    activeWorkspace: WORKSPACE_TWO,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    messages: [{ id: 'keep', role: 'user', content: 'already here', timestamp: 0 }],
    piStatus: 'running',
    currentView: 'home',
  })

  const ok = await useAppStore.getState().openFolderAsWorkspace(WORKSPACE_TWO.path)

  assert.equal(ok, true)
  assert.equal(
    calls.some((c) => c.startsWith('setActiveWorkspace:')),
    false,
    're-dropping the current project must not tear down the session via switch'
  )
  assert.equal(useAppStore.getState().messages[0]?.id, 'keep')
  assert.equal(useAppStore.getState().currentView, 'chat')
})

// A dropped folder that is already registered should use the normal background-safe
// workspace switch rather than asking the user to stop the old Pi turn.
test('dropping an existing workspace switches without a streaming confirmation', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    currentView: 'home',
  })
  enterStreamingState()

  const ok = await useAppStore.getState().openFolderAsWorkspace(WORKSPACE_TWO.path)

  assert.equal(ok, true)
  assert.equal(calls.some((c) => c.startsWith('createWorkspace:')), false)
  assert.equal(calls.includes(`setActiveWorkspace:${WORKSPACE_TWO.id}`), true)
  assert.equal(useAppStore.getState().activeWorkspace?.id, WORKSPACE_TWO.id)
  assert.equal(useAppStore.getState().messages.length, 0)
  assert.equal(useAppStore.getState().isStreaming, false)
})

test('openFolderAsWorkspace preserves surrounding whitespace in the folder path', async () => {
  // Legal POSIX folder name with a trailing space; trimming would probe a
  // different, nonexistent path.
  const SPACED_PATH = '/tmp/spaced '

  const ok = await useAppStore.getState().openFolderAsWorkspace(SPACED_PATH)

  assert.equal(ok, true)
  assert.equal(
    calls.includes(`pathKind:${SPACED_PATH}`),
    true,
    'the dropped path must reach main exactly as the OS reported it'
  )
})

// ─── Unsaved-editor guard ────────────────────────────────────────────────────
// The editor's dirty flag is mirrored into the store so every path that would
// silently destroy the edit buffer — showing another file, closing the editor,
// opening the diff pane over it, switching workspace — asks first.

const CODE_FILE: PreviewTarget = {
  kind: 'code',
  name: 'a.ts',
  path: '/tmp/one/a.ts',
  relativePath: 'a.ts',
}

const OTHER_FILE: PreviewTarget = {
  kind: 'code',
  name: 'b.ts',
  path: '/tmp/one/b.ts',
  relativePath: 'b.ts',
}

test('editorDirty transitions are mirrored to main for the quit guard', () => {
  useAppStore.setState({ previewTarget: CODE_FILE })

  useAppStore.getState().setEditorDirty(true)
  useAppStore.getState().setEditorDirty(true)
  useAppStore.getState().setEditorDirty(false)
  // Direct set() writes (how switch/discard actions clear the flag) must
  // mirror too — main's cache going stale would make quit nag forever.
  useAppStore.setState({ editorDirty: true })
  useAppStore.setState({ editorDirty: false })

  assert.deepEqual(
    calls.filter((c) => c.startsWith('editorDirtyMirror:')),
    [
      `editorDirtyMirror:true:${CODE_FILE.name}`,
      'editorDirtyMirror:false:',
      `editorDirtyMirror:true:${CODE_FILE.name}`,
      'editorDirtyMirror:false:',
    ],
    'exactly one push per transition, with the file name while dirty'
  )
})

test('setPreviewTarget applies immediately when the editor is clean', async () => {
  useAppStore.setState({ previewTarget: CODE_FILE })

  const ok = await useAppStore.getState().setPreviewTarget(OTHER_FILE)

  assert.equal(ok, true)
  assert.equal(useAppStore.getState().previewTarget?.path, OTHER_FILE.path)
})

test('a dirty editor asks before showing another file; declining keeps it', async () => {
  useAppStore.setState({ previewTarget: CODE_FILE, editorDirty: true })
  answerConfirm(false)

  const ok = await useAppStore.getState().setPreviewTarget(OTHER_FILE)

  assert.equal(ok, false)
  assert.equal(
    useAppStore.getState().previewTarget?.path,
    CODE_FILE.path,
    'declining must keep the dirty file on screen'
  )
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('accepting the discard applies the new preview and clears the dirty flag', async () => {
  useAppStore.setState({ previewTarget: CODE_FILE, editorDirty: true })
  answerConfirm(true)

  const ok = await useAppStore.getState().setPreviewTarget(OTHER_FILE)

  assert.equal(ok, true)
  assert.equal(useAppStore.getState().previewTarget?.path, OTHER_FILE.path)
  assert.equal(useAppStore.getState().editorDirty, false)
})

test('re-selecting the same dirty file needs no confirmation and keeps the buffer', async () => {
  useAppStore.setState({ previewTarget: CODE_FILE, editorDirty: true })

  const ok = await useAppStore.getState().setPreviewTarget({ ...CODE_FILE })

  assert.equal(ok, true)
  assert.equal(
    useAppStore.getState().editorDirty,
    true,
    'the edit buffer survives a same-file re-select, so the flag must too'
  )
})

test('closing a dirty editor asks first; declining keeps it open', async () => {
  useAppStore.setState({ previewTarget: CODE_FILE, editorDirty: true })
  answerConfirm(false)

  const ok = await useAppStore.getState().setPreviewTarget(null)

  assert.equal(ok, false)
  assert.equal(useAppStore.getState().previewTarget?.path, CODE_FILE.path)
})

test('opening the diff over a dirty editor asks first; declining keeps the panel', async () => {
  useAppStore.setState({ previewTarget: CODE_FILE, editorDirty: true, chatSidePanel: null })
  answerConfirm(false)

  const ok = await useAppStore.getState().setChatSidePanel('diff')

  assert.equal(ok, false)
  assert.equal(useAppStore.getState().chatSidePanel, null)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('accepting the diff-open discards the buffer', async () => {
  useAppStore.setState({ previewTarget: CODE_FILE, editorDirty: true, chatSidePanel: null })
  answerConfirm(true)

  const ok = await useAppStore.getState().setChatSidePanel('diff')

  assert.equal(ok, true)
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  assert.equal(useAppStore.getState().editorDirty, false)
})

test('non-diff panel changes never ask — the editor pane stays mounted', async () => {
  useAppStore.setState({ previewTarget: CODE_FILE, editorDirty: true, chatSidePanel: null })

  const ok = await useAppStore.getState().setChatSidePanel('files')

  assert.equal(ok, true)
  assert.equal(useAppStore.getState().chatSidePanel, 'files')
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('switchWorkspace asks before discarding a dirty editor; declining aborts the switch', async () => {
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  answerConfirm(false)

  const switched = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(switched, false)
  assert.equal(
    calls.some((c) => c.startsWith('setActiveWorkspace:')),
    false,
    'a declined discard must abort the switch before setActive'
  )
  assert.equal(useAppStore.getState().previewTarget?.path, CODE_FILE.path)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('accepting the editor discard lets the workspace switch proceed', async () => {
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  answerConfirm(true)

  const switched = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(switched, true)
  assert.equal(calls.includes(`setActiveWorkspace:${WORKSPACE_ID}`), true)
  assert.equal(useAppStore.getState().editorDirty, false)
})

test('a committed workspace switch closes the preview', async () => {
  // The open file belongs to the workspace being left; the new workspace's
  // file service would refuse to touch it anyway.
  useAppStore.setState({ activeWorkspace: WORKSPACE_ONE, previewTarget: CODE_FILE })

  const switched = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(switched, true)
  assert.equal(useAppStore.getState().previewTarget, null)
})

test('a main-side activation adoption closes the preview too', async () => {
  // Same rationale as the committed switch: after main promotes another
  // workspace (duplicate-path create, active-workspace removal), the file on
  // screen belongs to a workspace that is no longer active.
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  activeWorkspaceResult = WORKSPACE_TWO

  await useAppStore.getState().createWorkspace(WORKSPACE_TWO.name, WORKSPACE_TWO.path)

  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().editorDirty, false)
})

test('a chat file link declined by the dirty editor changes nothing', async () => {
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  fileSearchResults = [
    { name: 'b.ts', path: '/tmp/one/b.ts', relativePath: 'b.ts', matchType: 'name' },
  ]
  answerConfirm(false)

  await openFileFromChat('b.ts')

  assert.equal(useAppStore.getState().previewTarget?.path, CODE_FILE.path)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('an accepted chat file link opens the file', async () => {
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  fileSearchResults = [
    { name: 'b.ts', path: '/tmp/one/b.ts', relativePath: 'b.ts', matchType: 'name' },
  ]
  answerConfirm(true)

  await openFileFromChat('b.ts')

  assert.equal(useAppStore.getState().previewTarget?.path, '/tmp/one/b.ts')
  assert.equal(useAppStore.getState().editorDirty, false)
})

test('removing a workspace asks first; declining leaves it registered', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
  })
  answerConfirm(false)

  await useAppStore.getState().removeWorkspace(WORKSPACE_TWO.id)

  assert.equal(
    calls.some((c) => c.startsWith('removeWorkspace:')),
    false,
    'a declined removal must never reach main'
  )
})

test('removing the active workspace with a dirty editor asks about the edits too', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  // Yes to the removal, no to discarding the edits.
  answerConfirms([true, false])

  await useAppStore.getState().removeWorkspace(WORKSPACE_ONE.id)

  assert.equal(
    calls.some((c) => c.startsWith('removeWorkspace:')),
    false,
    'declining the discard must abort the removal'
  )
  assert.equal(useAppStore.getState().previewTarget?.path, CODE_FILE.path)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('removing an inactive workspace never asks about the editor', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  // Only the removal dialog; an unexpected second dialog would hang the test.
  answerConfirm(true)

  await useAppStore.getState().removeWorkspace(WORKSPACE_TWO.id)

  assert.equal(calls.includes(`removeWorkspace:${WORKSPACE_TWO.id}`), true)
  assert.equal(useAppStore.getState().previewTarget?.path, CODE_FILE.path)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('creating a duplicate-path workspace asks before activating over a dirty editor', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  answerConfirm(false)

  await useAppStore.getState().createWorkspace(WORKSPACE_TWO.name, WORKSPACE_TWO.path)

  assert.equal(
    calls.some((c) => c.startsWith('createWorkspace:')),
    false,
    'main activates a duplicate path inside create, so the ask must come before the IPC'
  )
  assert.equal(useAppStore.getState().activeWorkspace?.id, WORKSPACE_ONE.id)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('a duplicate-path create routes through the full workspace switch', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    messages: [{ id: 'old', role: 'user', content: 'from workspace one', timestamp: 0 }],
  })

  await useAppStore.getState().createWorkspace(WORKSPACE_TWO.name, WORKSPACE_TWO.path)

  assert.equal(
    calls.some((c) => c.startsWith('createWorkspace:')),
    false,
    'main would activate inside create, skipping the switch teardown'
  )
  assert.equal(calls.includes(`setActiveWorkspace:${WORKSPACE_TWO.id}`), true)
  assert.deepEqual(
    useAppStore.getState().messages,
    [],
    'the previous workspace chat must clear like any other switch'
  )
})

test('a duplicate-path create switches while Pi keeps working in the background', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
  })
  enterStreamingState()

  await useAppStore.getState().createWorkspace(WORKSPACE_TWO.name, WORKSPACE_TWO.path)

  assert.equal(calls.some((c) => c.startsWith('createWorkspace:')), false)
  assert.equal(calls.includes(`setActiveWorkspace:${WORKSPACE_TWO.id}`), true)
  assert.equal(useAppStore.getState().isStreaming, false)
})

test('creating the already-active path is a no-op', async () => {
  workspaceListResult = [WORKSPACE_ONE]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE],
    messages: [{ id: 'keep', role: 'user', content: 'stay', timestamp: 0 }],
  })

  await useAppStore.getState().createWorkspace(WORKSPACE_ONE.name, WORKSPACE_ONE.path)

  assert.equal(calls.length, 0, 'nothing to create and nothing to switch')
  assert.equal(useAppStore.getState().messages[0]?.id, 'keep')
})

test('a new-path create leaves a dirty editor alone', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  workspaceListResult = [WORKSPACE_ONE]
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE],
    previewTarget: CODE_FILE,
    editorDirty: true,
  })

  await useAppStore.getState().createWorkspace('fresh', '/tmp/fresh')

  assert.equal(calls.includes('createWorkspace:fresh:/tmp/fresh'), true)
  assert.equal(useAppStore.getState().previewTarget?.path, CODE_FILE.path)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('changing the active workspace folder asks a dirty editor first', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  answerConfirm(false)

  await useAppStore.getState().changeWorkspaceFolder(WORKSPACE_ONE.id, '/tmp/elsewhere')

  assert.equal(
    calls.some((c) => c.startsWith('changePath:')),
    false,
    'a declined discard must leave the folder unchanged'
  )
  assert.equal(useAppStore.getState().previewTarget?.path, CODE_FILE.path)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('an accepted active-folder change closes the preview', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    previewTarget: CODE_FILE,
    editorDirty: true,
  })
  answerConfirm(true)

  await useAppStore.getState().changeWorkspaceFolder(WORKSPACE_ONE.id, '/tmp/elsewhere')

  assert.equal(calls.includes(`changePath:${WORKSPACE_ONE.id}:/tmp/elsewhere`), true)
  assert.equal(
    useAppStore.getState().previewTarget,
    null,
    'the open file binds the old folder and is unsaveable under the new root'
  )
  assert.equal(useAppStore.getState().editorDirty, false)
})

test('changing the active folder warns while Pi is streaming', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({ activeWorkspace: WORKSPACE_ONE })
  enterStreamingState()
  answerConfirm(false)

  await useAppStore.getState().changeWorkspaceFolder(WORKSPACE_ONE.id, '/tmp/elsewhere')

  assert.equal(
    calls.some((c) => c.startsWith('changePath:')),
    false,
    'the restart below would kill the in-flight turn, so declining must abort'
  )
  assert.equal(useAppStore.getState().isStreaming, true)
})

test('an accepted active-folder change restarts a running Pi', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({ activeWorkspace: WORKSPACE_ONE, piStatus: 'running' })

  await useAppStore.getState().changeWorkspaceFolder(WORKSPACE_ONE.id, '/tmp/elsewhere')

  assert.equal(calls.includes(`changePath:${WORKSPACE_ONE.id}:/tmp/elsewhere`), true)
  assert.equal(
    calls.includes('pi.restart'),
    true,
    "Pi's cwd is bound at spawn — without a restart it keeps working in the old folder"
  )
})

test('a stopped Pi is not restarted by a folder change', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({ activeWorkspace: WORKSPACE_ONE, piStatus: 'stopped' })

  await useAppStore.getState().changeWorkspaceFolder(WORKSPACE_ONE.id, '/tmp/elsewhere')

  assert.equal(calls.includes(`changePath:${WORKSPACE_ONE.id}:/tmp/elsewhere`), true)
  assert.equal(calls.includes('pi.restart'), false)
})

test('changing an inactive workspace folder touches neither dialog nor preview', async () => {
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    previewTarget: CODE_FILE,
    editorDirty: true,
  })

  await useAppStore.getState().changeWorkspaceFolder(WORKSPACE_TWO.id, '/tmp/elsewhere')

  assert.equal(calls.includes(`changePath:${WORKSPACE_TWO.id}:/tmp/elsewhere`), true)
  assert.equal(useAppStore.getState().previewTarget?.path, CODE_FILE.path)
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('a chat file link closes a diff pane opened while its search was in flight', async () => {
  useAppStore.setState({ activeWorkspace: WORKSPACE_ONE, chatSidePanel: null })
  fileSearchResults = [
    { name: 'b.ts', path: '/tmp/one/b.ts', relativePath: 'b.ts', matchType: 'name' },
  ]
  // The user opens the diff pane while the search IPC is still out — the
  // pane check must read current state, not the pre-await snapshot.
  fileSearchHook = () => {
    useAppStore.setState({ chatSidePanel: 'diff' })
  }

  await openFileFromChat('b.ts')

  assert.equal(useAppStore.getState().previewTarget?.path, '/tmp/one/b.ts')
  assert.equal(
    useAppStore.getState().chatSidePanel,
    null,
    'the diff pane must make way for the preview it would otherwise hide'
  )
})

// ─── Cross-workspace session open (skipSessionLoad contract) ─────────────────
// The sidebar/session-panel flow is: switchWorkspace({skipSessionLoad}) then
// switchSession(target). The workspace switch clears the chat; the target is
// very often the new workspace's remembered active session, so the fast path
// must not eat the follow-up click.

test('switchSession loads history even when sessionState already names the target', async () => {
  // Post-workspace-switch state: chat cleared, sessionState already refreshed
  // to the very session the user clicked.
  useAppStore.setState({
    sessionState: sessionStateWith(SESSION_PATH),
    messages: [],
    sessionLoading: false,
  })

  await useAppStore.getState().switchSession(SESSION_PATH)

  assert.equal(
    calls.includes(`switch:${SESSION_PATH}`),
    true,
    'an empty chat means nothing is on screen — the session must load'
  )
})

test('switchSession still skips a reload when the session is already on screen', async () => {
  useAppStore.setState({
    sessionState: sessionStateWith(SESSION_PATH),
    messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 0 }],
    sessionLoading: false,
  })

  await useAppStore.getState().switchSession(SESSION_PATH)

  assert.equal(calls.includes(`switch:${SESSION_PATH}`), false)
})

test('the cross-workspace open flow loads the clicked session end to end', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
  })
  // The target workspace's Pi resumes straight onto the very session the user
  // clicked (startPi refreshes sessionState to it) — the arrangement whose
  // refresh/fast-path race used to eat the click and leave an empty chat.
  sessionStateResult = sessionStateWith(SESSION_PATH)

  const ok = await useAppStore.getState().switchWorkspace(WORKSPACE_ID, { skipSessionLoad: true })
  assert.equal(ok, true)
  await useAppStore.getState().switchSession(SESSION_PATH)

  assert.equal(
    calls.includes(`switch:${SESSION_PATH}`),
    true,
    'the chat was cleared by the workspace switch, so the session must actually load'
  )
})

// ─── openSessionItem (shared sidebar / session-panel / quick-switcher flow) ──

function sessionItemFor(workspace: Workspace): SessionListItem {
  return {
    path: SESSION_PATH,
    name: 'target session',
    preview: null,
    sessionId: 'target-1',
    lastModified: 0,
    messageCount: 1,
    projectPath: workspace.path,
    projectName: workspace.name,
  }
}

test('openSessionItem in the active workspace switches straight to the session', async () => {
  workspaceListResult = [WORKSPACE_ONE]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE],
    currentView: 'sessions',
  })

  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_ONE))

  assert.equal(calls.some((c) => c.startsWith('setActiveWorkspace')), false)
  assert.equal(calls.includes(`switch:${SESSION_PATH}`), true)
  assert.equal(useAppStore.getState().currentView, 'chat')
})

test('openSessionItem auto-switches to the owning workspace first', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    currentView: 'sessions',
  })

  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_TWO))

  assert.equal(calls.includes(`setActiveWorkspace:${WORKSPACE_TWO.id}`), true)
  assert.equal(calls.includes(`switch:${SESSION_PATH}`), true)
  assert.equal(useAppStore.getState().currentView, 'chat')
})

// ─── Mid-turn re-attach on workspace switch-back ─────────────────────────────

function enterWorkspacesWithBackgroundTurn(): void {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  // The background turn lives in WORKSPACE_TWO's own process, so main reports
  // that workspace's manager as running and its activity as working.
  piStatusResult = 'running'
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    workspaceActivity: { [WORKSPACE_ID]: { state: 'working', since: 1 } },
  })
}

test('openSessionItem switches tabs before opening the requested session', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    currentView: 'sessions',
  })
  enterStreamingState()

  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_TWO))

  assert.equal(calls.includes(`setActiveWorkspace:${WORKSPACE_TWO.id}`), true)
  assert.equal(calls.includes(`switch:${SESSION_PATH}`), true)
  assert.equal(useAppStore.getState().currentView, 'chat')
})

test('openSessionItem creates a workspace for an unknown project path', async () => {
  workspaceListResult = [WORKSPACE_ONE]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE],
    currentView: 'sessions',
  })

  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_TWO))

  assert.equal(
    calls.includes(`createWorkspace:${WORKSPACE_TWO.name}:${WORKSPACE_TWO.path}`),
    true,
    'an unknown project path must get a workspace before the session switch'
  )
  assert.equal(calls.includes(`switch:${SESSION_PATH}`), true)
})

test('switching into a working workspace shows the indicator and marks the attach', async () => {
  enterWorkspacesWithBackgroundTurn()

  const ok = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(ok, true)
  const state = useAppStore.getState()
  assert.equal(state.isStreaming, true, 'a running background turn must not render as an idle chat')
  assert.equal(state.reattachedMidTurn, true)
})

test('switching into an idle workspace attaches nothing', async () => {
  enterWorkspacesWithBackgroundTurn()
  useAppStore.setState({ workspaceActivity: {} })

  await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  const state = useAppStore.getState()
  assert.equal(state.isStreaming, false)
  assert.equal(state.reattachedMidTurn, false)
})

test('agent_end after a mid-turn attach backfills from the session', async () => {
  enterWorkspacesWithBackgroundTurn()
  await useAppStore.getState().switchWorkspace(WORKSPACE_ID)
  const loadsBefore = calls.filter((c) => c === 'getMessages').length

  useAppStore.getState().handlePiEvent({ type: 'agent_end', messages: [] })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const state = useAppStore.getState()
  assert.equal(state.reattachedMidTurn, false)
  assert.equal(state.isStreaming, false)
  assert.equal(
    calls.filter((c) => c === 'getMessages').length,
    loadsBefore + 1,
    'the stream buffers missed the pre-attach output — the session is the source of truth'
  )
})

test('the activity map going quiet after an attach stops the indicator and backfills', async () => {
  enterWorkspacesWithBackgroundTurn()
  await useAppStore.getState().switchWorkspace(WORKSPACE_ID)
  const loadsBefore = calls.filter((c) => c === 'getMessages').length

  // The turn ended during the switch: its agent_end was filtered while the
  // manager was not yet active, so only the activity broadcast reports it.
  useAppStore.getState().handleWorkspaceActivity({})
  await new Promise((resolve) => setTimeout(resolve, 20))

  const state = useAppStore.getState()
  assert.equal(state.isStreaming, false)
  assert.equal(state.reattachedMidTurn, false)
  assert.equal(calls.filter((c) => c === 'getMessages').length, loadsBefore + 1)
})

test('opening a mid-turn session row leaves the other runtime working', async () => {
  enterWorkspacesWithBackgroundTurn()
  sessionStateResult = sessionStateWith(SESSION_PATH)
  switchResult = {
    runtimeId: 'rt-opened',
    workspaceId: WORKSPACE_TWO.id,
    sessionPath: SESSION_PATH,
    sessionId: 'session-2',
    status: 'stopped',
    pid: null,
    error: null,
    activity: null,
    active: true,
  }

  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_TWO))

  const state = useAppStore.getState()
  assert.equal(calls.includes(`switch:${SESSION_PATH}`), true)
  assert.equal(state.sessionLoading, true, 'hydration defers until the runtime reports running')
  assert.equal(state.isStreaming, false, 'the selected session starts idle until its own events arrive')

  // Main finishes spawning the selected runtime; its running event hydrates.
  useAppStore.getState().handleSessionRuntime({
    runtimeId: 'rt-opened',
    workspaceId: WORKSPACE_TWO.id,
    sessionPath: SESSION_PATH,
    sessionId: 'session-2',
    status: 'running',
    pid: 7,
    error: null,
    activity: null,
    active: true,
  })
  // Flush the microtask chain the fire-and-forget hydration rides on — no
  // wall-clock wait needed for a mocked getMessages.
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(calls.includes('getMessages'), true, 'the running event hydrates history')
  assert.equal(useAppStore.getState().sessionLoading, false)
})

test('opening a different session mid-turn does not prompt or stop the other runtime', async () => {
  enterWorkspacesWithBackgroundTurn()
  sessionStateResult = sessionStateWith('/tmp/other-turn-session.jsonl')

  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_TWO))

  assert.equal(calls.includes(`switch:${SESSION_PATH}`), true)
  assert.equal(useAppStore.getState().reattachedMidTurn, false)
})

test('a background runtime never blocks session navigation with a warning', async () => {
  enterWorkspacesWithBackgroundTurn()
  sessionStateResult = sessionStateWith('/tmp/other-turn-session.jsonl')

  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_TWO))

  assert.equal(calls.includes(`switch:${SESSION_PATH}`), true)
  assert.equal(useAppStore.getState().confirmRequest, null)
})

test('a mid-turn message_end keeps the attach armed and restores the indicator', async () => {
  enterWorkspacesWithBackgroundTurn()
  await useAppStore.getState().switchWorkspace(WORKSPACE_ID)
  const loadsBefore = calls.filter((c) => c === 'getMessages').length

  // The in-flight message completes but the TURN continues (tool-using
  // turns have several messages). The backfill's teardown clears the
  // indicator; it must come back, and the attach must stay armed so the
  // kill-gates keep warning and later boundaries keep backfilling.
  useAppStore.getState().handlePiEvent({ type: 'message_end', message: {} })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const state = useAppStore.getState()
  assert.equal(state.reattachedMidTurn, true)
  assert.equal(state.isStreaming, true, 'the turn is still running — the UI must not look idle')
  assert.equal(calls.filter((c) => c === 'getMessages').length, loadsBefore + 1)
})

test('an activity broadcast arms the attach for a renderer that booted mid-turn', async () => {
  // Ctrl+R mid-turn: the fresh renderer is idle while Pi still streams.
  workspaceListResult = [WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_TWO
  useAppStore.setState({ activeWorkspace: WORKSPACE_TWO, workspaces: [WORKSPACE_TWO] })

  useAppStore.getState().handleWorkspaceActivity({ [WORKSPACE_ID]: { state: 'working', since: 1 } })

  const state = useAppStore.getState()
  assert.equal(state.isStreaming, true)
  assert.equal(state.reattachedMidTurn, true)
})

test('the boot arm stays out of session-change teardown windows', async () => {
  workspaceListResult = [WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_TWO
  useAppStore.setState({
    activeWorkspace: WORKSPACE_TWO,
    workspaces: [WORKSPACE_TWO],
    sessionLoading: true,
  })

  useAppStore.getState().handleWorkspaceActivity({ [WORKSPACE_ID]: { state: 'working', since: 1 } })

  assert.equal(useAppStore.getState().reattachedMidTurn, false)
})

test('session navigation does not require workspace re-attachment', async () => {
  enterWorkspacesWithBackgroundTurn()
  sessionStateResult = sessionStateWith(SESSION_PATH)
  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_TWO))

  assert.equal(useAppStore.getState().reattachedMidTurn, false)
  assert.equal(useAppStore.getState().isStreaming, false)
})

test('a live on-screen stream is never re-attached over', async () => {
  // Same-workspace navigation back to the streaming session: the fast path
  // short-circuits (session already on screen) and the live stream needs no
  // attach — reattachedMidTurn stays clear so no spurious backfill runs.
  enterWorkspacesWithBackgroundTurn()
  activeWorkspaceResult = WORKSPACE_TWO
  useAppStore.setState({
    activeWorkspace: WORKSPACE_TWO,
    isStreaming: true,
    sessionState: sessionStateWith(SESSION_PATH),
    messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 0 }],
  })

  await useAppStore.getState().openSessionItem(sessionItemFor(WORKSPACE_TWO))

  assert.equal(useAppStore.getState().reattachedMidTurn, false)
  assert.equal(useAppStore.getState().isStreaming, true)
})

test('an activity update that still shows working keeps the attach alive', async () => {
  enterWorkspacesWithBackgroundTurn()
  await useAppStore.getState().switchWorkspace(WORKSPACE_ID)
  const loadsBefore = calls.filter((c) => c === 'getMessages').length

  useAppStore.getState().handleWorkspaceActivity({ [WORKSPACE_ID]: { state: 'working', since: 2 } })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const state = useAppStore.getState()
  assert.equal(state.isStreaming, true)
  assert.equal(state.reattachedMidTurn, true)
  assert.equal(calls.filter((c) => c === 'getMessages').length, loadsBefore)
})

// ─── Boot/reload recovery ────────────────────────────────────────────────────

test('recoverPendingPrompts applies the counts snapshot and flushes the active workspace', async () => {
  pendingPromptsSnapshot = { 'ws-9': 2 }
  activeWorkspaceResult = WORKSPACE_TWO

  await useAppStore.getState().recoverPendingPrompts()

  assert.deepEqual(useAppStore.getState().pendingPromptCounts, { 'ws-9': 2 })
  assert.equal(
    calls.includes(`flushPendingPrompts:${WORKSPACE_TWO.id}`),
    true,
    'a reload leaves the dialog slot empty while main still holds the prompt'
  )
})

test('recoverPendingPrompts applies the workspace-activity snapshot', async () => {
  workspaceActivitySnapshot = { 'ws-9': { state: 'completed', since: 123 } }
  activeWorkspaceResult = WORKSPACE_TWO

  await useAppStore.getState().recoverPendingPrompts()

  assert.deepEqual(useAppStore.getState().workspaceActivity, {
    'ws-9': { state: 'completed', since: 123 },
  })
})

test('a rejected activity snapshot does not block prompt recovery', async () => {
  workspaceActivityFailure = 'activity bridge gone'
  pendingPromptsSnapshot = { 'ws-9': 2 }
  activeWorkspaceResult = WORKSPACE_TWO

  await assert.doesNotReject(() => useAppStore.getState().recoverPendingPrompts())

  assert.deepEqual(useAppStore.getState().pendingPromptCounts, { 'ws-9': 2 })
  assert.equal(calls.includes(`flushPendingPrompts:${WORKSPACE_TWO.id}`), true)
})

test('recoverPendingPrompts flushes nothing when no workspace is active', async () => {
  pendingPromptsSnapshot = { 'ws-9': 1 }
  activeWorkspaceResult = null

  await useAppStore.getState().recoverPendingPrompts()

  assert.deepEqual(useAppStore.getState().pendingPromptCounts, { 'ws-9': 1 })
  assert.equal(calls.some((c) => c.startsWith('flushPendingPrompts')), false)
})

test('recoverPendingPrompts swallows a rejected snapshot', async () => {
  pendingPromptsFailure = 'pending-prompts bridge gone'
  activeWorkspaceResult = WORKSPACE_TWO

  await assert.doesNotReject(() => useAppStore.getState().recoverPendingPrompts())

  assert.deepEqual(
    useAppStore.getState().pendingPromptCounts,
    {},
    'a failed recovery must leave the counts untouched'
  )
  assert.equal(calls.some((c) => c.startsWith('flushPendingPrompts')), false)
})

// ─── Extension UI stacking ───────────────────────────────────────────────────

// A toast and a blocking dialog can be on screen together. At the same tier the
// dialog's full-screen backdrop paints over the toast, so the click aimed at the
// toast lands on the backdrop and cancels the dialog — a permanent tool denial.
test('the notify toast sits above the blocking dialog backdrop', () => {
  assert.ok(
    NOTIFY_TOAST_Z_INDEX > DIALOG_OVERLAY_Z_INDEX,
    'a toast at or below the backdrop tier turns a toast click into a hard deny'
  )
})

// ─── View scopes (sessions + workflow panel) ─────────────────────────────────

// The sessions scope is lifted into the store so SessionPanel remounts (every
// navigation) can't drop it and sidebar entry points can set it explicitly.
test('setSessionsScope toggles the sessions view scope', () => {
  assert.equal(useAppStore.getState().sessionsScope, 'all')
  useAppStore.getState().setSessionsScope('current')
  assert.equal(useAppStore.getState().sessionsScope, 'current')
  useAppStore.getState().setSessionsScope('all')
  assert.equal(useAppStore.getState().sessionsScope, 'all')
})

test('openWorkflowRunsForWorkspace opens a project scope and clears session scope', () => {
  useAppStore.getState().openWorkflowRunsForWorkspace(WORKSPACE_ONE.id)
  const state = useAppStore.getState()
  assert.equal(state.workflowPanelOpen, true)
  assert.equal(state.workflowPanelWorkspaceId, WORKSPACE_ONE.id)
  assert.equal(state.workflowPanelFilter, null)
})

test('openWorkflowRunsForWorkspace(null) opens the global scope (Tools entry)', () => {
  useAppStore.getState().openWorkflowRunsForWorkspace(null)
  const state = useAppStore.getState()
  assert.equal(state.workflowPanelOpen, true)
  assert.equal(state.workflowPanelWorkspaceId, null)
  assert.equal(state.workflowPanelFilter, null)
})

test('openWorkflowRunsForSession overrides a project scope (session wins)', () => {
  useAppStore.getState().openWorkflowRunsForWorkspace(WORKSPACE_ONE.id)
  useAppStore.getState().openWorkflowRunsForSession('01b2b3c4-d5e6-4f70-a8b9-0c1d2e3f4a5b')
  const state = useAppStore.getState()
  assert.equal(state.workflowPanelWorkspaceId, null)
  assert.equal(state.workflowPanelFilter, '01b2b3c4-d5e6-4f70-a8b9-0c1d2e3f4a5b')
})

test('setWorkflowPanelOpen: direct open clears scope, close preserves it', () => {
  useAppStore.getState().openWorkflowRunsForWorkspace(WORKSPACE_ONE.id)
  useAppStore.getState().setWorkflowPanelOpen(false)
  assert.equal(useAppStore.getState().workflowPanelOpen, false)
  assert.equal(
    useAppStore.getState().workflowPanelWorkspaceId,
    WORKSPACE_ONE.id,
    'closing must preserve the scope so a reopen stays in the same project'
  )
  useAppStore.getState().setWorkflowPanelOpen(true)
  assert.equal(useAppStore.getState().workflowPanelWorkspaceId, null)
  assert.equal(useAppStore.getState().workflowPanelFilter, null)
})
