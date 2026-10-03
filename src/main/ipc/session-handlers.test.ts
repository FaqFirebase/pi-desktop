import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext } from './context'
import type { PiStartOptions, SessionRuntimeInfo } from '../../shared/ipc-contracts'
import { buildPiArgs } from '../pi-rpc-manager'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { configureGuiDataDir } from '../app-data-paths'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

test('new sessions receive the persisted model and reasoning preference', async () => {
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
  const root = await mkdtemp(join(tmpdir(), 'pi-new-effort-'))
  configureGuiDataDir(root)
  try {
    const { registerSessionHandlers } = await import('./session-handlers')
    const { saveAppSettings } = await import('./settings')
    await saveAppSettings({ defaultProvider: 'test', defaultModel: 'chosen', defaultThinkingLevel: 'high' })
    const runtime = { runtimeId: 'new', workspaceId: 'workspace' }
    let started!: (options: PiStartOptions) => void
    const optionsReady = new Promise<PiStartOptions>((resolve) => { started = resolve })
    registerSessionHandlers({
      workspaceManager: {
        getActiveWorkspace: () => ({ id: 'workspace', path: root }),
        getWorkspaces: () => [{ id: 'workspace', path: root }],
        createNewSessionRuntime: async () => runtime,
        startSessionRuntime: async (_id: string, options: PiStartOptions) => { started(options) },
      },
    } as unknown as IpcContext)
    assert.equal(await handlers.get(IPC_CHANNELS.SESSION_NEW)!(null), runtime)
    const args = buildPiArgs(await optionsReady)
    assert.equal(args[args.indexOf('--model') + 1], 'chosen')
    assert.equal(args[args.indexOf('--thinking') + 1], 'high')
    assert.equal(args.includes('--continue'), false)
  } finally {
    electronModule.exports = originalExports
    await rm(root, { recursive: true, force: true })
  }
})

test('switching back to an unpersisted live session reuses its runtime', async () => {
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

test('the resume target is the project runtime session, else its newest used file when resuming', async () => {
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
  const root = await mkdtemp(join(tmpdir(), 'pi-resume-'))
  const project = join(root, 'project')
  const originalRoot = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  configureGuiDataDir(root)
  try {
    const { registerSessionHandlers } = await import('./session-handlers')
    const { sanitizePath } = await import('../session-paths')
    const sessionDir = join(root, 'sessions', sanitizePath(project))
    await mkdir(sessionDir, { recursive: true })
    const onDisk = join(sessionDir, 'last.jsonl')
    await writeFile(onDisk, [
      JSON.stringify({ type: 'session', id: 'last', cwd: project }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
    ].join('\n'))
    let current: { sessionPath: string | null } | null = null
    registerSessionHandlers({
      workspaceManager: {
        getActiveWorkspace: () => ({ id: 'workspace', path: project }),
        getWorkspaces: () => [{ id: 'workspace', path: project }],
        getWorkspaceSessionRuntime: (id: string) => id === 'workspace' ? current : null,
      },
    } as unknown as IpcContext)
    const resumeTarget = handlers.get(IPC_CHANNELS.SESSION_RESUME_TARGET)!
    const { saveAppSettings } = await import('./settings')

    assert.equal(await resumeTarget(null, project), onDisk)
    await saveAppSettings({ resumeLastSession: false })
    assert.equal(await resumeTarget(null, project), null, 'the setting off never resumes a file')
    assert.equal(await resumeTarget(null, join(root, 'unregistered')), null)
    current = { sessionPath: null }
    assert.equal(await resumeTarget(null, project), null, 'an unsaved new session keeps the empty chat')
    current = { sessionPath: join(sessionDir, 'open-tab.jsonl') }
    assert.equal(await resumeTarget(null, project), current.sessionPath, 'a bound runtime shows its session with the setting off too')
  } finally {
    electronModule.exports = originalExports
    if (originalRoot === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalRoot
    await rm(root, { recursive: true, force: true })
  }
})
