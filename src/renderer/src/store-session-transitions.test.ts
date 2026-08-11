import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiExtensionUiRequest, Workspace } from '../../shared/ipc-contracts'
import type { PreviewTarget } from './store'

// Each recorded call is appended to `calls`, so tests can assert both that a
// session change reached Pi and that nothing reached Pi when it was declined.
const calls: string[] = []
let switchResult: { success?: boolean; error?: string } | null = { success: true }
// Non-null makes the stubbed pi.getStatus reject, simulating a main-side
// failure AFTER a workspace switch has already committed.
let getStatusFailure: string | null = null
// Non-null makes the stubbed workspace.setActive reject, simulating a switch
// that never commits on the main side.
let setActiveFailure: string | null = null
// Non-null makes the stubbed ui.getPendingPrompts reject, simulating a boot
// recovery that cannot reach main.
let pendingPromptsFailure: string | null = null
let pendingPromptsSnapshot: Record<string, number> = {}
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
      return { status: 'stopped' as const, pid: null, error: null }
    },
    start: async () => {
      calls.push('pi.start')
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
  calls.length = 0
  switchResult = { success: true }
  getStatusFailure = null
  setActiveFailure = null
  pendingPromptsFailure = null
  pendingPromptsSnapshot = {}
  activeWorkspaceResult = null
  workspaceListResult = []
  fileSearchResults = []
  fileSearchHook = null
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
    activeWorkspace: null,
    workspaces: [],
    piStatus: 'stopped',
    currentView: 'home',
    previewTarget: null,
    chatSidePanel: null,
    editorDirty: false,
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

test('a declined workspace switch keeps the dialog on screen', async () => {
  enterStreamingState()
  useAppStore.setState({ extensionUiRequest: EXTENSION_DIALOG })
  answerConfirm(false)

  const proceed = await useAppStore.getState().switchWorkspace(WORKSPACE_ID)

  assert.equal(proceed, false)
  assert.equal(useAppStore.getState().extensionUiRequest?.id, EXTENSION_DIALOG.id)
  assert.equal(
    calls.some((c) => c.startsWith('flushPendingPrompts')),
    false,
    'a declined switch must not replay prompts for a workspace the user never left for'
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
// the previous chat/messages and a stale piStatus that blocks starting the new Pi.
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
    'running',
    'switchWorkspace resyncs status then startPi can start the target manager'
  )
  // After create main already activated TWO; startPi still runs because status
  // was resynced to stopped from getStatus before start.
  assert.equal(calls.includes('pi.start'), true)
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

// Regression: a dropped folder that is already a registered (but inactive)
// workspace must activate through switchWorkspace's confirm gate only. Routing
// it through createWorkspace lets main activate the duplicate path before the
// "still working" dialog appears, so declining left main and the sidebar on the
// new workspace while the chat pane still held the old one.
test('declining the confirm while dropping an existing workspace leaves everything in place', async () => {
  workspaceListResult = [WORKSPACE_ONE, WORKSPACE_TWO]
  activeWorkspaceResult = WORKSPACE_ONE
  useAppStore.setState({
    activeWorkspace: WORKSPACE_ONE,
    workspaces: [WORKSPACE_ONE, WORKSPACE_TWO],
    currentView: 'home',
  })
  enterStreamingState()
  answerConfirm(false)

  const ok = await useAppStore.getState().openFolderAsWorkspace(WORKSPACE_TWO.path)

  assert.equal(ok, false)
  assert.equal(
    calls.some((c) => c.startsWith('createWorkspace:')),
    false,
    'create activates a duplicate path on main before the confirm can run'
  )
  assert.equal(
    calls.some((c) => c.startsWith('setActiveWorkspace:')),
    false,
    'a declined switch must leave the main-side active workspace untouched'
  )
  assert.equal(useAppStore.getState().activeWorkspace?.id, WORKSPACE_ONE.id)
  assert.equal(
    useAppStore.getState().messages[0]?.id,
    'm1',
    'the streaming chat must survive a declined switch'
  )
  assert.equal(useAppStore.getState().isStreaming, true)
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
