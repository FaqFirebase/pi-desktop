import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelInfo, Workspace } from '../../shared/ipc-contracts'

const MODEL: ModelInfo = {
  id: 'test-model', name: 'Test model', provider: 'test', api: 'test', baseUrl: '',
  reasoning: true, input: ['text'], contextWindow: 1000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const WORKSPACE: Workspace = {
  id: 'one', name: 'One', path: '/tmp/one', color: '#000', createdAt: 0, lastActiveAt: 0,
}
const calls: string[] = []
let startHook: (() => Promise<void>) | null = null
let listHook: (() => Promise<void>) | null = null
let listResponse: unknown
let startFailure: Error | null = null
let useAppStore: typeof import('./store')['useAppStore']

before(async () => {
  Object.assign(globalThis, {
    window: {
      piDesktop: {
        pi: {
          start: async () => {
            calls.push('start')
            await startHook?.()
            if (startFailure) throw startFailure
            return { status: 'running', pid: 123, engine: 'pi', error: null }
          },
        },
        model: {
          listAvailable: async () => {
            calls.push('list')
            await listHook?.()
            return listResponse
          },
          set: async (provider: string, id: string) => {
            calls.push(`set:${provider}/${id}`)
            return { success: true }
          },
        },
        settings: {
          save: async (settings: unknown) => {
            calls.push('save')
            return settings
          },
        },
        session: {
          getState: async () => ({ success: true, data: { model: MODEL } }),
          getStats: async () => ({ success: true, data: null }),
          list: async () => [],
        },
        permissionRules: { workspaceStatus: async () => ({ hasWorkspaceRules: false }) },
        commands: { prompt: async () => { calls.push('prompt') } },
      },
    },
  })
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  calls.length = 0
  startHook = null
  listHook = null
  startFailure = null
  listResponse = { success: true, data: { models: [MODEL] } }
  useAppStore.setState({
    activeWorkspace: WORKSPACE, activeSessionRuntimeId: null,
    piStatus: 'stopped', piPid: null, piError: null,
    sessionState: null, sessionStats: null, messages: [],
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('a fresh composer can list and select models before sending its first prompt', async () => {
  assert.deepEqual(await useAppStore.getState().listModels(), [MODEL])
  assert.deepEqual(calls, ['start', 'list'])
  assert.equal(useAppStore.getState().sessionState?.model?.id, MODEL.id)

  await useAppStore.getState().setModel(MODEL.provider, MODEL.id)
  assert.deepEqual(calls, ['start', 'list', 'set:test/test-model', 'save'])
  assert.equal(useAppStore.getState().settings?.defaultModel, MODEL.id)
  assert.deepEqual(useAppStore.getState().messages, [])
})

test('listing models reuses an already running runtime', async () => {
  useAppStore.setState({ piStatus: 'running', piEngine: 'omp' })
  assert.deepEqual(await useAppStore.getState().listModels(), [MODEL])
  assert.deepEqual(calls, ['list'])
})

test('listing waits for startup readiness', async () => {
  const ready = deferred()
  startHook = () => ready.promise
  useAppStore.setState({ piStatus: 'starting' })
  const pending = useAppStore.getState().listModels()
  assert.deepEqual(calls, ['start'])
  ready.resolve()
  assert.deepEqual(await pending, [MODEL])
  assert.deepEqual(calls, ['start', 'list'])
})

test('startup failures reach the picker and a later open can retry', async () => {
  startFailure = new Error('binary unavailable')
  await assert.rejects(useAppStore.getState().listModels())
  assert.deepEqual(calls, ['start'])
  assert.equal(useAppStore.getState().piStatus, 'error')
  startFailure = null
  assert.deepEqual(await useAppStore.getState().listModels(), [MODEL])
  assert.deepEqual(calls, ['start', 'start', 'list'])
})

test('unsuccessful catalog responses are errors, not empty catalogs', async () => {
  useAppStore.setState({ piStatus: 'running' })
  for (const response of [null, { success: false }, { success: true, data: {} }]) {
    listResponse = response
    await assert.rejects(useAppStore.getState().listModels())
  }
  listResponse = { success: true, data: { models: [] } }
  assert.deepEqual(await useAppStore.getState().listModels(), [])
})

test('catalog transport failures reach the picker', async () => {
  useAppStore.setState({ piStatus: 'running' })
  listHook = async () => { throw new Error('RPC disconnected') }
  await assert.rejects(useAppStore.getState().listModels(), /RPC disconnected/)
})

test('navigating away during startup does not load models or overwrite the new workspace', async () => {
  const ready = deferred()
  startHook = () => ready.promise
  const pending = useAppStore.getState().listModels()
  useAppStore.setState({ activeWorkspace: { ...WORKSPACE, id: 'two' } })
  ready.resolve()
  await assert.rejects(pending)
  assert.deepEqual(calls, ['start'])
  assert.equal(useAppStore.getState().piStatus, 'stopped')
  assert.equal(useAppStore.getState().sessionState, null)
})

test('late startup failures do not mark the newly selected workspace as failed', async () => {
  const ready = deferred()
  startHook = () => ready.promise
  startFailure = new Error('binary unavailable')
  const pending = useAppStore.getState().listModels()
  useAppStore.setState({ activeWorkspace: { ...WORKSPACE, id: 'two' } })
  ready.resolve()
  await assert.rejects(pending)
  assert.equal(useAppStore.getState().piStatus, 'stopped')
  assert.equal(useAppStore.getState().piError, null)
})

test('a catalog arriving after workspace navigation is discarded', async () => {
  useAppStore.setState({ piStatus: 'running' })
  const ready = deferred()
  listHook = () => ready.promise
  const pending = useAppStore.getState().listModels()
  useAppStore.setState({ activeWorkspace: { ...WORKSPACE, id: 'two' } })
  ready.resolve()
  await assert.rejects(pending)
})
