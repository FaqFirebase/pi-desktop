import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext } from './context'
import type { AgentEngineKind } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { ModelsConfig } from '../../shared/models-config'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

const PI_PROVIDERS: ModelsConfig = { providers: { 'pi-only': { baseUrl: 'http://localhost:1', models: [{ id: 'one' }] } } }
const OMP_PROVIDERS: ModelsConfig = { providers: { 'omp-only': { baseUrl: 'http://localhost:2', models: [{ id: 'two' }] } } }

/**
 * Register the models handlers in a temporary home whose engine in use is
 * `engineInUse`, the engine main itself would pick for a read.
 */
async function withModelsHandlers(
  engineInUse: AgentEngineKind,
  fn: (paths: { piFile: string; ompFile: string; home: string }) => Promise<void>
): Promise<void> {
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  require('electron')
  const electronModule = require.cache[electronPath]!
  const originalExports = electronModule.exports
  handlers.clear()
  electronModule.exports = {
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  }
  const home = await mkdtemp(join(tmpdir(), 'pi-models-home-'))
  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    const { registerModelsConfigHandlers } = await import('./models-config-handlers')
    registerModelsConfigHandlers({
      workspaceManager: { getActivePiManager: () => ({ getEngineKind: () => engineInUse }) },
    } as unknown as IpcContext)
    await fn({
      home,
      piFile: join(home, '.pi', 'agent', 'models.json'),
      ompFile: join(home, '.omp', 'agent', 'models.yml'),
    })
  } finally {
    electronModule.exports = originalExports
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    await rm(home, { recursive: true, force: true })
  }
}

async function write(config: unknown, engine: unknown): Promise<unknown> {
  return handlers.get(IPC_CHANNELS.MODELS_WRITE)!(null, config, engine)
}

// The editor loaded one engine's file, then the engine in use changed under it.
test('a save writes the models file of the engine the editor loaded, not the one in use now', async () => {
  await withModelsHandlers('omp', async ({ piFile, ompFile }) => {
    const ompText = '# OMP keeps its own providers\nproviders:\n  omp-only:\n    baseUrl: http://localhost:2\n'
    await mkdir(join(ompFile, '..'), { recursive: true })
    await writeFile(ompFile, ompText, 'utf-8')

    assert.deepEqual(await write(PI_PROVIDERS, 'pi'), { success: true })

    assert.deepEqual(JSON.parse(await readFile(piFile, 'utf-8')), PI_PROVIDERS)
    assert.equal(await readFile(ompFile, 'utf-8'), ompText, "the other engine's file and its comments stay as they were")
  })
})

test('an OMP save writes the OMP file while Pi is in use', async () => {
  await withModelsHandlers('pi', async ({ piFile, ompFile }) => {
    await mkdir(join(piFile, '..'), { recursive: true })
    await writeFile(piFile, JSON.stringify(PI_PROVIDERS), 'utf-8')

    assert.deepEqual(await write(OMP_PROVIDERS, 'omp'), { success: true })

    assert.match(await readFile(ompFile, 'utf-8'), /omp-only/)
    assert.deepEqual(JSON.parse(await readFile(piFile, 'utf-8')), PI_PROVIDERS)
  })
})

test('a save that names no known engine is refused and writes nothing', async () => {
  await withModelsHandlers('pi', async ({ home }) => {
    for (const engine of [undefined, 'auto', 'claude', 7]) {
      const result = await write(PI_PROVIDERS, engine) as { success: boolean }
      assert.equal(result.success, false, `engine ${String(engine)} must be refused`)
    }

    assert.equal(existsSync(join(home, '.pi')), false)
    assert.equal(existsSync(join(home, '.omp')), false)
  })
})
