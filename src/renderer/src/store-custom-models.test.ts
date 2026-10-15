import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEngineKind, AppSettings, ModelsFileInfo, ModelsReadResult, Workspace } from '../../shared/ipc-contracts'
import type { ModelsConfig } from '../../shared/models-config'

const PI_FILE: ModelsFileInfo = { engine: 'pi', file: '/home/user/.pi/agent/models.json', name: 'models.json' }
const OMP_FILE: ModelsFileInfo = { engine: 'omp', file: '/home/user/.omp/agent/models.yml', name: 'models.yml' }
const PI_MODELS: ModelsConfig = { providers: { 'pi-only': { models: [{ id: 'one' }] } } }
const OMP_MODELS: ModelsConfig = { providers: { 'omp-only': { models: [{ id: 'two' }] } } }
const EDITED: ModelsConfig = { providers: { edited: { models: [{ id: 'three' }] } } }
const WORKSPACE: Workspace = { id: 'one', name: 'One', path: '/tmp/one', color: '#000', createdAt: 0, lastActiveAt: 0 }

// The engine main resolves for a read, as activeEngineKind does.
let engineInUse: AgentEngineKind = 'pi'
// Holds a read until the test releases it, to interleave changes with it.
let readGate: Promise<void> | null = null
let reads = 0
// True: each read returns a fresh copy, as the IPC does.
let cloneReads = false
const writes: Array<{ config: unknown; engine: unknown }> = []

function fileOf(engine: AgentEngineKind): ModelsReadResult {
  return engine === 'omp' ? { config: OMP_MODELS, location: OMP_FILE } : { config: PI_MODELS, location: PI_FILE }
}

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    piDesktop: {
      models: {
        read: async () => {
          reads += 1
          const engine = engineInUse
          if (readGate) await readGate
          return cloneReads ? structuredClone(fileOf(engine)) : fileOf(engine)
        },
        write: async (config: unknown, engine: unknown) => {
          writes.push({ config, engine })
          return { success: true }
        },
      },
    },
  }
  ;({ useAppStore } = await import('./store'))
})

beforeEach(async () => {
  engineInUse = 'pi'
  readGate = null
  cloneReads = false
  writes.length = 0
  useAppStore.setState({
    activeWorkspace: WORKSPACE,
    activeSessionRuntimeId: null,
    piEngine: 'pi',
    settings: null,
    customModelsEdited: false,
  })
  await useAppStore.getState().loadCustomModels()
  reads = 0
})

function release(): () => void {
  let open!: () => void
  readGate = new Promise<void>((resolve) => { open = resolve })
  return () => {
    readGate = null
    open()
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

test('a save writes the file the editor loaded, also after the engine in use changed', async () => {
  useAppStore.getState().setCustomModelsEdited(true)
  engineInUse = 'omp'
  useAppStore.setState({ piEngine: 'omp' })

  assert.deepEqual(await useAppStore.getState().saveCustomModels(EDITED), { ok: true })

  assert.deepEqual(writes.map((entry) => entry.engine), ['pi'], 'the edits were made on the Pi file')
  assert.equal(useAppStore.getState().customModelsEdited, false)
  assert.equal(useAppStore.getState().customModelsFile, OMP_FILE, 'after the save the editor follows the engine in use')
})

test('a save before the models file loaded writes nothing', async () => {
  useAppStore.setState({ customModels: null, customModelsFile: null })

  const result = await useAppStore.getState().saveCustomModels(EDITED)

  assert.equal(result.ok, false)
  assert.deepEqual(writes, [])
})

test('each change that can move main to another engine reloads an editor with no unsaved edits', async () => {
  const changes: Array<[string, () => void]> = [
    ['workspace', () => useAppStore.setState({ activeWorkspace: { ...WORKSPACE, id: 'two' } })],
    ['session runtime', () => useAppStore.setState({ activeSessionRuntimeId: 'rt-omp' })],
    ['running engine', () => useAppStore.setState({ piEngine: 'omp' })],
    ['engine setting', () => useAppStore.setState({ settings: { piEngine: 'omp' } as AppSettings })],
    ['executable path', () => useAppStore.setState({ settings: { piEngine: 'omp', piExecutablePath: '/opt/omp' } as AppSettings })],
  ]
  for (const [name, change] of changes) {
    const before = reads
    engineInUse = engineInUse === 'pi' ? 'omp' : 'pi'
    change()
    await settle()
    assert.equal(reads, before + 1, `a ${name} change must reload`)
    assert.equal(useAppStore.getState().customModelsFile?.engine, engineInUse, `after a ${name} change`)
  }
})

test('a store change that cannot move main to another engine reads nothing', async () => {
  useAppStore.setState({ messages: [], settings: { piEngine: 'pi', sidebarWidth: 300 } as AppSettings })
  await settle()
  const before = reads
  useAppStore.setState({ settings: { piEngine: 'pi', sidebarWidth: 320 } as AppSettings })
  await settle()
  assert.equal(reads, before)
})

// Every chat bubble reads customModels for model names: a reload that finds
// the same file must not hand them a new object to render again.
test('a reload that reads the same content keeps the same models object', async () => {
  cloneReads = true
  const shown = useAppStore.getState().customModels

  useAppStore.setState({ activeSessionRuntimeId: 'rt-two' })
  await settle()

  assert.equal(reads, 1)
  assert.equal(useAppStore.getState().customModels, shown)
})

test('unsaved edits keep the file they were made on when the engine changes', async () => {
  useAppStore.getState().setCustomModelsEdited(true)
  engineInUse = 'omp'

  useAppStore.setState({ piEngine: 'omp' })
  await settle()

  assert.equal(reads, 0)
  assert.equal(useAppStore.getState().customModelsFile, PI_FILE)
  assert.equal(useAppStore.getState().customModels, PI_MODELS)
})

test('edits begun while the file reloads keep the file they were made on', async () => {
  const open = release()
  engineInUse = 'omp'
  useAppStore.setState({ piEngine: 'omp' })
  useAppStore.getState().setCustomModelsEdited(true)
  open()
  await settle()

  assert.equal(reads, 1)
  assert.equal(useAppStore.getState().customModelsFile, PI_FILE)
})

test('a read that a newer read overtook is dropped', async () => {
  const open = release()
  useAppStore.setState({ activeWorkspace: { ...WORKSPACE, id: 'two' } })
  engineInUse = 'omp'
  readGate = null
  useAppStore.setState({ piEngine: 'omp' })
  await settle()
  assert.equal(useAppStore.getState().customModelsFile, OMP_FILE)

  open()
  await settle()

  assert.equal(reads, 2)
  assert.equal(useAppStore.getState().customModelsFile, OMP_FILE, 'the older Pi read must not win')
})
