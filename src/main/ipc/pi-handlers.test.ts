import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext } from './context'
import type { PiStatus } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { configureGuiDataDir } from '../app-data-paths'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

test('a session restart reports the engine that now runs', async () => {
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
    const restartedStatus: PiStatus = { status: 'running', pid: 4242, error: null, engine: 'omp' }
    const manager = { getStatus: () => restartedStatus }
    const runtime = { runtimeId: 'runtime' }
    const restarted: string[] = []
    registerPiHandlers({
      workspaceManager: {
        getActiveWorkspace: () => ({ id: 'workspace', path: root }),
        getPiManager: () => manager,
        runtimeIdFor: () => runtime.runtimeId,
        getSessionRuntime: () => runtime,
        restartSessionRuntime: async (runtimeId: string) => {
          restarted.push(runtimeId)
          return { ...restartedStatus, runtimeId }
        },
      },
      getActivePi: () => manager,
    } as unknown as IpcContext)

    const status = await handlers.get(IPC_CHANNELS.PI_RESTART)!(null) as PiStatus

    assert.deepEqual(restarted, [runtime.runtimeId])
    // the renderer reads a missing engine as Pi, so an OMP restart showed "Pi"
    assert.equal(status.engine, 'omp')
    assert.equal(status.pid, restartedStatus.pid)
  } finally {
    electronModule.exports = originalExports
    await rm(root, { recursive: true, force: true })
  }
})
