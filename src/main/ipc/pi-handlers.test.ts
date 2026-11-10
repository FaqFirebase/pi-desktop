import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext } from './context'
import type { PiStartOptions, PiStatus } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { configureGuiDataDir } from '../app-data-paths'
import { buildPiArgs } from '../pi-rpc-manager'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const RESTARTED_STATUS: PiStatus = { status: 'running', pid: 4242, error: null, engine: 'omp' }
const RUNTIME_ID = 'runtime'

/**
 * Register the Pi handlers against a workspace with one session runtime, and
 * record the options each restart of that runtime gets.
 */
async function withRestartableRuntime(
  fn: (restarts: PiStartOptions[], root: string) => Promise<void>
): Promise<void> {
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  require('electron')
  const electronModule = require.cache[electronPath]!
  const originalExports = electronModule.exports
  handlers.clear()
  electronModule.exports = {
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    app: { isPackaged: false, getAppPath: () => process.cwd() },
  }
  const root = await mkdtemp(join(tmpdir(), 'pi-restart-'))
  configureGuiDataDir(root)
  try {
    const { registerPiHandlers } = await import('./pi-handlers')
    const manager = { getStatus: () => RESTARTED_STATUS }
    const runtime = { runtimeId: RUNTIME_ID }
    const restarts: PiStartOptions[] = []
    registerPiHandlers({
      workspaceManager: {
        getActiveWorkspace: () => ({ id: 'workspace', path: root }),
        getPiManager: () => manager,
        runtimeIdFor: () => RUNTIME_ID,
        getSessionRuntime: () => runtime,
        restartSessionRuntime: async (_runtimeId: string, options: PiStartOptions) => {
          restarts.push(options)
          return { ...RESTARTED_STATUS, runtimeId: RUNTIME_ID }
        },
      },
      getActivePi: () => manager,
    } as unknown as IpcContext)
    await fn(restarts, root)
  } finally {
    electronModule.exports = originalExports
    await rm(root, { recursive: true, force: true })
  }
}

test('a session restart reports the engine that now runs', async () => {
  await withRestartableRuntime(async (restarts) => {
    const status = await handlers.get(IPC_CHANNELS.PI_RESTART)!(null) as PiStatus

    assert.equal(restarts.length, 1)
    // the renderer reads a missing engine as Pi, so an OMP restart showed "Pi"
    assert.equal(status.engine, 'omp')
    assert.equal(status.pid, RESTARTED_STATUS.pid)
  })
})

test('a session restart keeps the model chosen in the GUI', async () => {
  await withRestartableRuntime(async (restarts) => {
    const { saveAppSettings } = await import('./settings')
    await saveAppSettings({ defaultProvider: 'chosen-provider', defaultModel: 'chosen-model' })

    await handlers.get(IPC_CHANNELS.PI_RESTART)!(null)

    // without it the engine runs its own default model, which may be one the user cannot use
    const args = buildPiArgs(restarts[0])
    assert.equal(args[args.indexOf('--provider') + 1], 'chosen-provider')
    assert.equal(args[args.indexOf('--model') + 1], 'chosen-model')
  })
})
