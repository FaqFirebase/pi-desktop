import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext } from './context'
import type { SessionRuntimeInfo } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { configureGuiDataDir } from '../app-data-paths'

test('switching back to an unpersisted live session reuses its runtime', async () => {
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  require('electron')
  const electronModule = require.cache[electronPath]!
  const originalExports = electronModule.exports
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  electronModule.exports = {
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    app: { isPackaged: false, getAppPath: () => process.cwd() },
  }
  const root = await mkdtemp(join(tmpdir(), 'pi-switch-'))
  const originalRoot = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  configureGuiDataDir(root)
  try {
    const { registerSessionHandlers } = await import('./session-handlers')
    const sessionPath = join(root, 'sessions', 'project', 'new.jsonl')
    let runtime: SessionRuntimeInfo | null = {
      runtimeId: 'new', workspaceId: 'workspace', sessionPath, sessionId: 'new',
      status: 'running', pid: 123, error: null, activity: null, active: false,
    }
    let activations = 0
    let starts = 0
    registerSessionHandlers({
      workspaceManager: {
        getSessionRuntimeForPath: () => runtime,
        getActiveWorkspace: () => ({ id: 'workspace', path: root }),
        getWorkspaces: () => [{ id: 'workspace', path: root }],
        activateSession: async (workspaceId: string, path: string) => {
          assert.equal(workspaceId, 'workspace')
          assert.equal(path, sessionPath)
          activations++
          return runtime
        },
        startSessionRuntime: async () => { starts++ },
      },
    } as unknown as IpcContext)
    const switchSession = handlers.get(IPC_CHANNELS.SESSION_SWITCH)!
    assert.equal(await switchSession(null, sessionPath, root), runtime)
    runtime.status = 'starting'
    assert.equal(await switchSession(null, sessionPath, root), runtime)
    assert.equal(activations, 2)
    await assert.rejects(async () => switchSession(null, join(root, 'outside.jsonl'), root))
    await assert.rejects(async () => switchSession(null, sessionPath, join(root, 'other-project')))
    runtime.status = 'stopped'
    await assert.rejects(async () => switchSession(null, sessionPath, root))
    runtime = null
    await assert.rejects(async () => switchSession(null, sessionPath, root))
    assert.equal(activations, 2)
    assert.equal(starts, 0, 'must not restart a live runtime')
  } finally {
    electronModule.exports = originalExports
    if (originalRoot === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalRoot
    await rm(root, { recursive: true, force: true })
  }
})
