import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionRuntimeInfo, Workspace } from '../../shared/ipc-contracts'

const WORKSPACE: Workspace = {
  id: 'one', name: 'One', path: '/tmp/one', color: '#000', createdAt: 0, lastActiveAt: 0,
}
const OTHER_WORKSPACE: Workspace = { ...WORKSPACE, id: 'two', name: 'Two', path: '/tmp/two' }
const LAST_SESSION = '/home/user/.pi/agent/sessions/--tmp-one--/last.jsonl'

const calls: string[] = []
const startOptions: unknown[] = []
let latestSession: string | null = null
let lookupHook: (() => Promise<void>) | null = null
let useAppStore: typeof import('./store')['useAppStore']

function runtimeFor(sessionPath: string): SessionRuntimeInfo {
  return {
    runtimeId: 'resumed', workspaceId: WORKSPACE.id, sessionPath, sessionId: 'last', activity: null,
    active: true, status: 'starting', pid: null, error: null,
  }
}

before(async () => {
  Object.assign(globalThis, {
    window: {
      piDesktop: {
        pi: {
          start: async (options?: unknown) => {
            calls.push('start')
            startOptions.push(options)
            return { status: 'running', pid: 1, engine: 'pi', error: null }
          },
        },
        model: { listAvailable: async () => ({ success: true, data: { models: [] } }) },
        session: {
          resumeTarget: async (cwd: string) => {
            calls.push(`latest:${cwd}`)
            await lookupHook?.()
            return latestSession
          },
          switch: async (path: string) => {
            calls.push(`switch:${path}`)
            return runtimeFor(path)
          },
          getState: async () => ({ success: true, data: null }),
          getStats: async () => ({ success: true, data: null }),
          getMessages: async () => ({ success: true, data: { messages: [] } }),
          list: async () => [],
        },
        workspace: {
          setActive: async (id: string) => (id === OTHER_WORKSPACE.id ? OTHER_WORKSPACE : WORKSPACE),
        },
        ui: { flushPendingPrompts: async () => undefined },
        permissionRules: { workspaceStatus: async () => ({ hasWorkspaceRules: false }) },
        commands: { prompt: async () => { calls.push('prompt') } },
      },
    },
  })
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  calls.length = 0
  startOptions.length = 0
  latestSession = null
  lookupHook = null
  useAppStore.setState({
    activeWorkspace: WORKSPACE, workspaces: [WORKSPACE, OTHER_WORKSPACE], activeSessionRuntimeId: null,
    piStatus: 'stopped', piPid: null, piError: null, sessionRuntimes: {},
    sessionState: null, sessionStats: null, messages: [], sessionLoading: false,
  })
})

test('opening a project with a previous session shows that session', async () => {
  latestSession = LAST_SESSION
  assert.equal(await useAppStore.getState().openLastSession(), true)
  assert.deepEqual(calls, [`latest:${WORKSPACE.path}`, `switch:${LAST_SESSION}`])
  assert.equal(useAppStore.getState().activeSessionRuntimeId, 'resumed')
})

test('a project without a previous session keeps the empty chat', async () => {
  assert.equal(await useAppStore.getState().openLastSession(), false)
  assert.deepEqual(calls, [`latest:${WORKSPACE.path}`])
  assert.equal(useAppStore.getState().sessionLoading, false)
})

test('with nothing to resume the first prompt starts a new session', async () => {
  assert.equal(await useAppStore.getState().openLastSession(), false)
  await useAppStore.getState().sendPrompt('hello')
  assert.deepEqual(calls, [`latest:${WORKSPACE.path}`, 'start', 'prompt'])
  assert.deepEqual(startOptions, [{ continueSession: false }])
})

test('an empty chat never continues an earlier session through a start', async () => {
  await useAppStore.getState().sendPrompt('hello')
  useAppStore.setState({ piStatus: 'stopped' })
  await useAppStore.getState().listModels()
  assert.deepEqual(startOptions, [{ continueSession: false }, { continueSession: false }])
})

test('a prompt sent during the lookup joins the resumed session', async () => {
  latestSession = LAST_SESSION
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  lookupHook = () => gate
  const resuming = useAppStore.getState().openLastSession()
  const sending = useAppStore.getState().sendPrompt('hello')
  await Promise.resolve()
  release()
  await Promise.all([resuming, sending])
  assert.deepEqual(calls, [`latest:${WORKSPACE.path}`, `switch:${LAST_SESSION}`, 'start', 'prompt'])
})

test('activating a project with no running session resumes its last session', async () => {
  latestSession = LAST_SESSION
  useAppStore.setState({ activeWorkspace: OTHER_WORKSPACE })
  await useAppStore.getState().activateWorkspace(WORKSPACE.id)
  // The resume runs in the background after the switch commits.
  for (let tick = 0; tick < 100 && !calls.includes(`switch:${LAST_SESSION}`); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.deepEqual(calls, [`latest:${WORKSPACE.path}`, `switch:${LAST_SESSION}`])
})

test('activating a project to open a chosen session skips the resume', async () => {
  latestSession = LAST_SESSION
  useAppStore.setState({ activeWorkspace: OTHER_WORKSPACE })
  await useAppStore.getState().activateWorkspace(WORKSPACE.id, { awaitingSession: true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(calls, [])
})
