import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiExtensionUiRequest, Workspace } from '../../shared/ipc-contracts'

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
  },
  system: {
    pathKind: async (filePath: string) => {
      calls.push(`pathKind:${filePath}`)
      return { exists: true, isDirectory: true }
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
let DIALOG_OVERLAY_Z_INDEX: number
let NOTIFY_TOAST_Z_INDEX: number

// The store reaches for `window.piDesktop` inside its actions, so the bridge has
// to exist before the module body runs — hence the deferred import.
before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore, countPromptsWaitingElsewhere, formatPromptsWaiting } = await import('./store'))
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
  getStatusFailure = null
  setActiveFailure = null
  pendingPromptsFailure = null
  pendingPromptsSnapshot = {}
  activeWorkspaceResult = null
  workspaceListResult = []
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
