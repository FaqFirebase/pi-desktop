import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { IpcContext } from './context'
import type { QuickChatBinding, QuickChatContext, QuickChatSnapshot, QuickChatUpdate } from '../../shared/quick-chat'
import { QUICK_CHAT_CHANNELS } from '../../shared/quick-chat'
import { IPC_CHANNELS, type PiResponseEvent, type SessionRuntimeInfo, type Workspace } from '../../shared/ipc-contracts'
import type { WorkspaceManager } from '../workspace-manager'
import { configureGuiDataDir } from '../app-data-paths'
import { RENDERER_INDEX_PATH } from '../renderer-origin'
import { createPiEventRouter } from '../pi-event-router'
import { stripInjectedPreamble } from '../../shared/session-preview'
import { engineProjectSessionDirs } from '../latest-project-session'

// Electron names are bound when a main-process module first imports them, so
// the stub must be in place before any module that touches Electron loads.
// WorkspaceManager (via agent-resources) and every handler module are imported
// dynamically inside withBridge, after this stub is installed.
const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const electronModule = require.cache[electronPath]!
const originalExports = electronModule.exports
// Per-test override for the folder picker: pickWorkspace drives dialog.
const pickerResult: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
electronModule.exports = {
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
  app: {
    isPackaged: false, getAppPath: () => process.cwd(), getPreferredSystemLanguages: () => ['en'],
    getPath: (name: string) => name === 'home' ? '/home' : '',
  },
  dialog: { showOpenDialog: async () => pickerResult },
}

interface BridgeFixture {
  wm: WorkspaceManager
  alpha: SessionRuntimeInfo
  beta: SessionRuntimeInfo
  commands: Array<{ id: string; command: Record<string, unknown> }>
  updates: QuickChatUpdate[]
  broadcasts: Array<{ channel: string; data: unknown }>
  event: IpcMainInvokeEvent
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  getShows(): number
  setStreaming(busy: boolean): void
  setStateData(data: Record<string, unknown>): void
}

async function withBridge(run: (fixture: BridgeFixture) => Promise<void>): Promise<void> {
  handlers.clear()
  const root = await mkdtemp(join(tmpdir(), 'quick-chat-ipc-'))
  configureGuiDataDir(root)
  const { WorkspaceManager } = await import('../workspace-manager')
  const wm = new WorkspaceManager()
  await wm.initialize()
  try { await run(await fixture(wm, root)) } finally {
    wm.stopAll()
    electronModule.exports = originalExports
    await rm(root, { recursive: true, force: true })
  }
}

async function fixture(wm: WorkspaceManager, root: string): Promise<BridgeFixture> {
  // Load only after replacing Electron: the production module binds ipcMain on import.
  const { createQuickChatHandlers } = await import('./quick-chat-handlers')
  const { saveAppSettings } = await import('./settings')
  await saveAppSettings({ permissionMode: 'plan-readonly' })
  const workspace = await wm.createWorkspace('Project', root)
  const alpha = await wm.createNewSessionRuntime(workspace.id)
  const beta = await wm.createNewSessionRuntime(workspace.id)
  const commands: Array<{ id: string; command: Record<string, unknown> }> = []
  let streaming = false
  let stateData: Record<string, unknown> = { isStreaming: false }
  for (const runtime of [alpha, beta]) {
    const manager = wm.getSessionRuntimeManager(runtime.runtimeId)!
    manager.getStatus = () => ({ status: 'running', pid: 123, error: null })
    manager.getEngineKind = () => 'pi'
    manager.sendCommand = async (command): Promise<PiResponseEvent> => {
      commands.push({ id: runtime.runtimeId, command })
      if (command.type === 'prompt') {
        manager.emit('agent_start')
        manager.emit('agent_end')
      }
      if (command.type === 'get_available_models') {
        return { type: 'response', command: 'get_available_models', success: true, data: { models: [{ provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] } }
      }
      if (command.type === 'set_model') {
        return command.modelId === 'nope'
          ? { type: 'response', command: 'set_model', success: false, error: 'model not found' }
          : { type: 'response', command: 'set_model', success: true }
      }
      if (command.type === 'set_thinking_level') {
        return { type: 'response', command: 'set_thinking_level', success: true }
      }
      return {
        type: 'response', command: String(command.type), success: true,
        data: command.type === 'get_messages' ? { messages: [{ role: 'user', content: runtime.runtimeId }] } : { ...stateData, isStreaming: streaming },
      }
    }
  }
  let visible = true
  let visibility: (shown: boolean) => void = () => {}
  let shows = 0
  const updates: QuickChatUpdate[] = []
  const broadcasts: Array<{ channel: string; data: unknown }> = []
  const frame = { url: pathToFileURL(RENDERER_INDEX_PATH).href + '#quick-chat' }
  const webContents = { mainFrame: frame, send: (_channel: string, update: QuickChatUpdate) => updates.push(update) }
  const window = { webContents, isDestroyed: () => false, isVisible: () => visible } as unknown as BrowserWindow
  const main = { isDestroyed: () => false, isMinimized: () => false, show: () => {}, focus: () => {} } as unknown as BrowserWindow
  const ctx = {
    workspaceManager: wm,
    broadcast: (channel: string, data: unknown) => broadcasts.push({ channel, data }),
  } as unknown as IpcContext
  const bridge = createQuickChatHandlers(ctx, { getWindow: () => main, showWindow: () => { shows++ } }, {
    getWindow: () => window,
    hide: () => { visible = false; visibility(false) },
    onVisibility: (listener) => { visibility = listener },
  })
  const router = createPiEventRouter({
    ...bridge.routing,
    getActiveManager: () => wm.getActivePiManager(),
    workspaceIdFor: (manager) => wm.workspaceIdFor(manager),
    broadcastEvent: (event) => broadcasts.push({ channel: IPC_CHANNELS.EVENT_PI, data: event }),
    broadcastPendingCounts: () => {}, now: () => 0,
  })
  wm.onPiManager((manager) => router.attachManager(manager))
  bridge.register(router)
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  return { wm, alpha, beta, commands, updates, broadcasts, event, invoke, getShows: () => shows, setStreaming: (busy: boolean) => { streaming = busy }, setStateData: (data: Record<string, unknown>) => { stateData = data } }
}

test('popup operations target their pinned runtime, preserve plan mode, adapt activity races, and navigate only by guarded intent', async () => {
  await withBridge(async (h) => {
    const context = await h.invoke(QUICK_CHAT_CHANNELS.context) as QuickChatContext
    assert.equal(context.binding, null, 'the popup starts in new-task mode, never adopting the main runtime')
    assert.equal(context.defaultWorkspaceId, h.beta.workspaceId, 'the active workspace is the initial default')
    assert.ok(context.runtimeUpdatedAt[h.alpha.runtimeId] > 0 && context.runtimeUpdatedAt[h.beta.runtimeId] > 0, 'every runtime carries a recency stamp')
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    const snapshot = await h.invoke(QUICK_CHAT_CHANNELS.snapshot, binding.version) as QuickChatSnapshot
    assert.deepEqual(snapshot.messages, [{ role: 'user', content: h.alpha.runtimeId }])
    assert.equal(snapshot.streaming, null)
    await h.invoke(QUICK_CHAT_CHANNELS.submit, { version: binding.version, text: 'inspect this', mode: 'prompt' })
    const prompt = h.commands.find((item) => item.command.type === 'prompt')!
    assert.equal(prompt.id, h.alpha.runtimeId)
    assert.notEqual(prompt.command.message, 'inspect this')
    assert.equal(stripInjectedPreamble(String(prompt.command.message)), 'inspect this')
    h.setStreaming(true)
    // Stale prompt intent racing a stream start: the authoritative state routes
    // the send as a steer — one command, raw text, no plan wrapper.
    const beforeRace = h.commands.length
    await h.invoke(QUICK_CHAT_CHANNELS.submit, { version: binding.version, text: 'race', mode: 'prompt' })
    const race = h.commands.slice(beforeRace).filter((item) => item.command.type === 'prompt' || item.command.type === 'steer')
    assert.equal(race.length, 1)
    assert.equal(race[0].command.type, 'steer')
    assert.equal(String(race[0].command.message), 'race')
    // Busy execution steers.
    await h.invoke(QUICK_CHAT_CHANNELS.submit, { version: binding.version, text: 'more detail', mode: 'steer' })
    assert.equal(h.commands.filter((item) => item.command.type === 'steer').length, 2)
    h.setStreaming(false)
    // Stale steer intent racing an idle boundary: the send becomes a fresh
    // prompt — wrapped for plan-readonly — and activity settles through the
    // existing prompt path (agent_start/agent_end), never a rejected draft.
    const beforePrompt = h.commands.length
    await h.invoke(QUICK_CHAT_CHANNELS.submit, { version: binding.version, text: 'next plan', mode: 'steer' })
    const resumed = h.commands.slice(beforePrompt).filter((item) => item.command.type === 'prompt' || item.command.type === 'steer')
    assert.equal(resumed.length, 1)
    assert.equal(resumed[0].command.type, 'prompt')
    assert.equal(resumed[0].id, h.alpha.runtimeId)
    assert.notEqual(resumed[0].command.message, 'next plan')
    assert.equal(stripInjectedPreamble(String(resumed[0].command.message)), 'next plan')
    assert.equal(h.wm.getSessionRuntime(h.alpha.runtimeId)?.activity, 'completed')
    assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, h.beta.runtimeId)
    assert.equal(h.getShows(), 0, 'reading and submitting must not show main')
    await h.invoke(QUICK_CHAT_CHANNELS.openInMain)
    assert.equal(h.getShows(), 1)
    assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, h.beta.runtimeId, 'main renderer still owns the guarded switch')
    assert.deepEqual(h.broadcasts.find((item) => item.channel === IPC_CHANNELS.EVENT_ACTIVATE_WORKSPACE)?.data, { workspaceId: h.alpha.workspaceId, runtimeId: h.alpha.runtimeId })
  })
})

test('popup handlers reject other windows, subframes, stale bindings and mixed target identities', async () => {
  await withBridge(async (h) => {
    await h.invoke(QUICK_CHAT_CHANNELS.context)
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    await assert.rejects(handlers.get(QUICK_CHAT_CHANNELS.submit)!({ ...h.event, sender: {} } as IpcMainInvokeEvent, { version: binding.version, text: 'no', mode: 'prompt' }), /Unauthorized Quick Chat sender/)
    await assert.rejects(handlers.get(QUICK_CHAT_CHANNELS.context)!({ ...h.event, senderFrame: { url: h.event.senderFrame?.url } } as IpcMainInvokeEvent), /Unauthorized Quick Chat sender/)
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId, workspaceId: h.beta.workspaceId }))
    const next = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.beta.runtimeId }) as QuickChatBinding
    assert.ok(next.version > binding.version)
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.submit, { version: binding.version, text: 'old', mode: 'prompt' }))
    assert.equal(h.commands.some((item) => item.command.type === 'prompt'), false)
    await h.wm.closeSessionRuntime(h.beta.runtimeId)
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.submit, { version: next.version, text: 'closed', mode: 'prompt' }))
    const last = h.updates.filter((u) => u.type === 'binding').at(-1)
    assert.equal(last?.type, 'binding')
    assert.ok(last?.type === 'binding' && last.binding === null)
  })
})

test('late history from a previous binding is rejected rather than returned for the new session', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    const manager = h.wm.getSessionRuntimeManager(h.alpha.runtimeId)!
    const original = manager.sendCommand.bind(manager)
    let finish!: (response: PiResponseEvent) => void
    let entered!: () => void
    const reading = new Promise<void>((resolve) => { entered = resolve })
    manager.sendCommand = async (command) => {
      if (command.type !== 'get_messages') return original(command)
      entered()
      return new Promise<PiResponseEvent>((resolve) => { finish = resolve })
    }
    const history = h.invoke(QUICK_CHAT_CHANNELS.snapshot, binding.version)
    await reading
    await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.beta.runtimeId })
    finish({ type: 'response', command: 'get_messages', success: true, data: { messages: [{ role: 'assistant', content: 'old alpha' }] } })
    await assert.rejects(history)
  })
})

test('session admission is lazy and private; duplicate admission reuses it but New Task creates a fresh context', async () => {
  await withBridge(async (h) => {
    const activeBefore = h.wm.getActiveSessionRuntime()?.runtimeId
    const activeWorkspaceBefore = h.wm.getActiveWorkspaceId()
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.createSession, h.beta.workspaceId) as QuickChatBinding
    assert.equal(binding.runtime.status, 'stopped', 'a fresh session runtime is stopped and spawns nothing')
    assert.equal(binding.runtime.active, false, 'the popup runtime is never the main-active runtime')
    assert.equal(binding.runtime.sessionPath, null)
    assert.equal(h.wm.getSessionRuntime(binding.runtime.runtimeId)?.runtimeId, binding.runtime.runtimeId, 'the runtime is retained in the manager')
    assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, activeBefore, 'the main-active runtime never moves')
    assert.equal(h.wm.getActiveWorkspaceId(), activeWorkspaceBefore, 'the main-active workspace never moves')
    const manager = h.wm.getSessionRuntimeManager(binding.runtime.runtimeId)!
    assert.equal(manager.getStatus().status, 'stopped', 'no process was started for the inactive runtime')

    // Duplicate admission can reuse the current empty runtime, but entering
    // a new draft must never attach the next task to that prior context.
    const before = h.wm.getSessionRuntimes(h.beta.workspaceId).length
    const again = await h.invoke(QUICK_CHAT_CHANNELS.createSession, h.beta.workspaceId) as QuickChatBinding
    assert.equal(again.runtime.runtimeId, binding.runtime.runtimeId, 'retry reuses the popup-owned empty runtime')
    assert.equal(h.wm.getSessionRuntimes(h.beta.workspaceId).length, before, 'no duplicate tab is created')
    assert.equal(again.version, binding.version + 1, 'reuse still re-binds with a fresh version')
    assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, activeBefore, 'main pointer still untouched after reuse')
    await h.invoke(QUICK_CHAT_CHANNELS.newDraft)
    const fresh = await h.invoke(QUICK_CHAT_CHANNELS.createSession, h.beta.workspaceId) as QuickChatBinding
    assert.notEqual(fresh.runtime.runtimeId, binding.runtime.runtimeId)
    assert.equal(fresh.runtime.status, 'stopped')
    assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, activeBefore)
  })
})

test('createSession rejects malformed and unknown targets without creating anything', async () => {
  await withBridge(async (h) => {
    const runtimesBefore = h.wm.getSessionRuntimes().length
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.createSession, 123))
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.createSession, 'no-such-workspace'))
    assert.equal(h.wm.getSessionRuntimes().length, runtimesBefore, 'no runtime was created by failed calls')
  })
})

test('resolveHomeWorkspace materializes a Home workspace without activating it, and reuses it', async () => {
  await withBridge(async (h) => {
    const activeBefore = h.wm.getActiveWorkspaceId()
    const first = await h.invoke(QUICK_CHAT_CHANNELS.resolveHomeWorkspace) as Workspace
    assert.equal(first.name, 'Home')
    assert.equal(first.path, '/home')
    assert.equal(h.wm.getActiveWorkspaceId(), activeBefore, 'the popup must not move main active workspace')
    assert.equal(h.wm.getWorkspaces().filter((w) => w.path === '/home').length, 1)
    // A second call reuses the same workspace rather than duplicating it.
    const second = await h.invoke(QUICK_CHAT_CHANNELS.resolveHomeWorkspace) as Workspace
    assert.equal(second.id, first.id)
    assert.equal(h.wm.getWorkspaces().filter((w) => w.path === '/home').length, 1)
    assert.equal(h.wm.getActiveWorkspaceId(), activeBefore)
  })
})

test('newDraft unbinds without aborting, closing, or answering a held approval', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    const runtimeId = binding.runtime.runtimeId
    // The engine asks a blocking question; the router hands it to the popup.
    const manager = h.wm.getSessionRuntimeManager(runtimeId)!
    manager.emit('event', {
      type: 'extension_ui_request', id: 'ask-1', method: 'confirm',
      message: 'proceed?', timeout: 60_000,
    })
    const snapshot = await h.invoke(QUICK_CHAT_CHANNELS.snapshot, binding.version) as QuickChatSnapshot
    assert.equal(snapshot.request?.id, 'ask-1', 'the popup owns the held approval')

    await h.invoke(QUICK_CHAT_CHANNELS.newDraft)
    assert.ok(h.updates.some((u) => u.type === 'binding' && u.binding === null), 'newDraft unbinds the runtime')
    assert.equal(h.wm.getSessionRuntime(runtimeId)?.runtimeId, runtimeId, 'the runtime stays open')
    assert.equal(h.commands.some((item) => item.command.type === 'abort'), false, 'newDraft never aborts the turn')
    // The held approval is neither denied nor confirmed: no response command
    // reaches the engine, and the unbound version no longer authorizes one.
    assert.equal(h.commands.some((item) => item.command.type === 'extension_ui_response'), false, 'no implicit answer is sent')
    await assert.rejects(
      h.invoke(QUICK_CHAT_CHANNELS.respond, { version: binding.version, id: 'ask-1', response: { confirmed: false } }),
    )
  })
})

test('stop aborts only the bound running runtime and never starts or closes a stopped one', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.createSession, h.beta.workspaceId) as QuickChatBinding
    const manager = h.wm.getSessionRuntimeManager(binding.runtime.runtimeId)!
    // Give the runtime a live process so abort reaches the engine.
    manager.getStatus = () => ({ status: 'running', pid: 456, error: null })
    manager.sendCommand = async (command) => {
      h.commands.push({ id: binding.runtime.runtimeId, command })
      return { type: 'response', command: String(command.type), success: true }
    }
    h.wm.setSessionRuntimeActivity(binding.runtime.runtimeId, 'working')
    await h.invoke(QUICK_CHAT_CHANNELS.stop, binding.version)
    const abort = h.commands.find((item) => item.id === binding.runtime.runtimeId && item.command.type === 'abort')
    assert.ok(abort, 'stop sends an abort to the exact bound runtime')
    assert.equal(h.wm.getSessionRuntime(binding.runtime.runtimeId)?.runtimeId, binding.runtime.runtimeId, 'stop never closes the runtime')

    // A stopped target resolves as a no-op: no start, no abort command.
    const commandsBefore = h.commands.length
    const stopped = await h.invoke(QUICK_CHAT_CHANNELS.createSession, h.alpha.workspaceId) as QuickChatBinding
    assert.equal(stopped.runtime.status, 'stopped')
    await h.invoke(QUICK_CHAT_CHANNELS.stop, stopped.version)
    assert.equal(h.commands.length, commandsBefore, 'stopping a stopped runtime sends nothing')
    assert.equal(h.wm.getSessionRuntime(stopped.runtime.runtimeId)?.runtimeId, stopped.runtime.runtimeId)

    // A stale version cannot stop the current runtime.
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.stop, binding.version + 999))
    assert.equal(h.commands.length, commandsBefore)
  })
})

test('a snapshot of a stopped runtime reads its file and never starts the engine', async () => {
  await withBridge(async (h) => {
    const root = h.wm.getActiveWorkspace()!.path
    const saved = { pi: process.env.PI_CODING_AGENT_DIR }
    process.env.PI_CODING_AGENT_DIR = join(root, 'pi-store')
    try {
      const [directory] = await engineProjectSessionDirs('pi', root)
      await mkdir(directory, { recursive: true })
      const sessionPath = join(directory, 'stopped-session.jsonl')
      await writeFile(sessionPath, [
        { type: 'title', title: 'Stopped task' },
        { type: 'session', version: 3, id: 'stopped-task', cwd: root },
        { type: 'message', message: { role: 'user', content: 'First question', timestamp: 1 } },
        { type: 'message', message: { role: 'assistant', content: 'Partial answer', timestamp: 2 } },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { workspaceId: h.alpha.workspaceId, sessionPath }) as QuickChatBinding
      const manager = h.wm.getSessionRuntimeManager(binding.runtime.runtimeId)!
      manager.sendCommand = async (command): Promise<PiResponseEvent> => {
        h.commands.push({ id: binding.runtime.runtimeId, command })
        if (command.type === 'prompt') {
          manager.emit('agent_start')
          manager.emit('agent_end')
        }
        return {
          type: 'response', command: String(command.type), success: true,
          data: command.type === 'get_messages' ? { messages: [] } : { isStreaming: false },
        }
      }
      // The runtime is dead: a passive read must not spawn a process for it.
      manager.getStatus = () => ({ status: 'stopped', pid: null, error: null })
      let starts = 0
      manager.start = async () => { starts++; return { status: 'running', pid: 999, error: null } as never }
      const commandsBefore = h.commands.length
      const snapshot = await h.invoke(QUICK_CHAT_CHANNELS.snapshot, binding.version) as QuickChatSnapshot
      assert.equal(starts, 0, 'a snapshot never starts a stopped runtime')
      assert.equal(h.commands.length, commandsBefore, 'no get_messages/get_state reaches the engine either')
      const roles = snapshot.messages.map((message) =>
        message && typeof message === 'object' && 'role' in message && typeof message.role === 'string' ? message.role : null)
      assert.deepEqual(roles, ['user', 'assistant'])
      assert.equal(snapshot.streaming, null)
      // The user's own send still resumes the runtime through the normal path.
      manager.getStatus = () => ({ status: 'running', pid: 999, error: null })
      manager.start = async () => ({ status: 'running', pid: 999, error: null } as never)
      await h.invoke(QUICK_CHAT_CHANNELS.submit, { version: binding.version, text: 'resume', mode: 'prompt' })
      assert.ok(h.commands.some((item) => item.command.type === 'prompt'), 'submitting resumes the runtime and sends the prompt')
    } finally {
      if (saved.pi === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = saved.pi
    }
  })
})

test('a stopped runtime stays stopped after its status-change events refill the popup', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    const manager = h.wm.getSessionRuntimeManager(binding.runtime.runtimeId)!
    let starts = 0
    manager.start = async () => { starts++; return { status: 'running', pid: 999, error: null } as never }
    // The engine reports it stopped (abort, crash, or budget eviction); the
    // router forwards the status_change and the controller refills the view.
    manager.getStatus = () => ({ status: 'stopped', pid: null, error: null })
    manager.emit('status-change', 'stopped')
    const snapshot = await h.invoke(QUICK_CHAT_CHANNELS.snapshot, binding.version) as QuickChatSnapshot
    assert.equal(snapshot.streaming, null)
    assert.equal(starts, 0, 'the refill after a stop must not resurrect the process')
  })
})

test('pickWorkspace never moves the main active pointers and keeps the popup open', async () => {
  await withBridge(async (h) => {
    const activeWorkspace = h.wm.getActiveWorkspaceId()
    h.updates.length = 0
    pickerResult.canceled = true
    pickerResult.filePaths = []
    assert.equal(await h.invoke(QUICK_CHAT_CHANNELS.pickWorkspace), null)
    assert.equal(h.wm.getActiveWorkspaceId(), activeWorkspace, 'cancel keeps the active workspace')
    assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, h.beta.runtimeId)
    assert.equal(h.updates.filter((u) => u.type === 'runtimes').length, 0, 'cancel emits no runtimes update')
    assert.equal(h.wm.getSessionRuntimes().length, 2, 'cancel creates nothing')

    // Picking a new folder creates it but does not activate it.
    const pickedDir = await mkdtemp(join(tmpdir(), 'quick-chat-pick-'))
    pickerResult.canceled = false
    pickerResult.filePaths = [pickedDir]
    const workspace = await h.invoke(QUICK_CHAT_CHANNELS.pickWorkspace) as Workspace
    assert.ok(workspace.id, 'a new workspace is returned')
    assert.equal(h.wm.getActiveWorkspaceId(), activeWorkspace, 'the new workspace is not activated')
    assert.ok(h.wm.getWorkspaces().some((ws) => ws.id === workspace.id), 'the workspace is persisted')
    assert.ok(h.updates.some((u) => u.type === 'runtimes'), 'creation emits a runtimes update')

    // A duplicate folder returns the existing workspace without re-activating.
    pickerResult.filePaths = [pickedDir]
    const duplicate = await h.invoke(QUICK_CHAT_CHANNELS.pickWorkspace) as Workspace
    assert.equal(duplicate.id, workspace.id, 'duplicate folder resolves to the existing workspace')
    assert.equal(h.wm.getActiveWorkspaceId(), activeWorkspace, 'duplicate does not activate it either')
    assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, h.beta.runtimeId)
  })
})

test('pickWorkspace on a fresh manager creates the first workspace without activating it', async () => {
  // Static imports cannot work here: like withBridge below, these modules bind
  // Electron names at load time, so they must load only after the stub above
  // replaced the electron module (the same reason WorkspaceManager is a
  // type-only import at the top of this file).
  const { WorkspaceManager } = await import('../workspace-manager')
  const root = await mkdtemp(join(tmpdir(), 'quick-chat-first-picker-'))
  configureGuiDataDir(root)
  const { createQuickChatHandlers } = await import('./quick-chat-handlers')
  const fresh = new WorkspaceManager()
  await fresh.initialize()
  try {
    const frame = { url: pathToFileURL(RENDERER_INDEX_PATH).href + '#quick-chat' }
    const webContents = { mainFrame: frame, send: () => {} }
    const window = { webContents, isDestroyed: () => false, isVisible: () => true } as unknown as BrowserWindow
    const main = { isDestroyed: () => false, isMinimized: () => false, show: () => {}, focus: () => {} } as unknown as BrowserWindow
    const ctx = { workspaceManager: fresh, broadcast: () => {} } as unknown as IpcContext
    const bridge = createQuickChatHandlers(ctx, { getWindow: () => main, showWindow: () => {} }, {
      getWindow: () => window,
      hide: () => {},
      onVisibility: () => {},
    })
    const router = createPiEventRouter({
      ...bridge.routing,
      getActiveManager: () => fresh.getActivePiManager(),
      workspaceIdFor: (manager) => fresh.workspaceIdFor(manager),
      broadcastEvent: () => {},
      broadcastPendingCounts: () => {},
      now: () => 0,
    })
    fresh.onPiManager((manager) => router.attachManager(manager))
    bridge.register(router)
    const dir = await mkdtemp(join(tmpdir(), 'quick-chat-first-pick-'))
    pickerResult.canceled = false
    pickerResult.filePaths = [dir]
    const picked = await handlers.get(QUICK_CHAT_CHANNELS.pickWorkspace)!({ sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent) as Workspace
    assert.ok(picked.id)
    assert.equal(fresh.getActiveWorkspace(), null, 'the very first picker folder is not auto-activated')
    assert.ok(fresh.getWorkspaces().some((ws) => ws.id === picked.id))
  } finally {
    fresh.stopAll()
    await rm(root, { recursive: true, force: true })
  }
})

test('runtimes and visibility updates reach the popup for any runtime change', async () => {
  await withBridge(async (h) => {
    await h.invoke(QUICK_CHAT_CHANNELS.context)
    h.updates.length = 0
    // A non-bound runtime changing activity still emits a runtimes update.
    h.wm.setSessionRuntimeActivity(h.beta.runtimeId, 'working')
    const runtimeUpdate = h.updates.find((u) => u.type === 'runtimes')
    assert.ok(runtimeUpdate?.type === 'runtimes' && runtimeUpdate.runtimes.some((r) => r.runtimeId === h.beta.runtimeId), 'non-bound runtime changes emit runtimes updates')
    assert.ok(runtimeUpdate?.type === 'runtimes' && runtimeUpdate.updatedAt[h.beta.runtimeId] > 0, 'the update carries the recency stamp')
    // Hiding emits a visibility update.
    h.updates.length = 0
    await h.invoke(QUICK_CHAT_CHANNELS.hide)
    const visibility = h.updates.at(-1)
    assert.ok(visibility?.type === 'visibility' && visibility.visible === false, 'hiding emits a visibility update')
  })
})

test('a rejected Stop surfaces the engine error and leaves the target and main selection intact', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    const manager = h.wm.getSessionRuntimeManager(h.alpha.runtimeId)!
    manager.sendCommand = async () => ({ type: 'response', command: 'abort', success: false, error: 'abort rejected by engine' })
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.stop, binding.version), { message: 'abort rejected by engine' })
    assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, h.beta.runtimeId)
    assert.equal(h.wm.getSessionRuntime(h.alpha.runtimeId)?.runtimeId, h.alpha.runtimeId)
  })
})

test('a snapshot carries the runtime model/thinking from get_state and the recorded permission mode', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    // The fixture runtime is mocked as already running, so it never passes
    // through the start path that records the permission mode: it is
    // unconfirmed until a real start records it.
    let snapshot = await h.invoke(QUICK_CHAT_CHANNELS.snapshot, binding.version) as QuickChatSnapshot
    assert.equal(snapshot.model, null, 'no model yet: get_state has none')
    assert.equal(snapshot.thinkingLevel, null)
    assert.equal(snapshot.permissionMode, null, 'never started through the app startup path is unconfirmed')
    // get_state now reports a model and thinking level.
    h.setStateData({ model: { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, thinkingLevel: 'high' })
    snapshot = await h.invoke(QUICK_CHAT_CHANNELS.snapshot, binding.version) as QuickChatSnapshot
    assert.deepEqual(snapshot.model, { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' })
    assert.equal(snapshot.thinkingLevel, 'high')
    assert.equal(snapshot.permissionMode, null)
  })
})

test('submit applies a draft-selected model and thinking level before the prompt, and only when idle', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    await h.invoke(QUICK_CHAT_CHANNELS.submit, {
      version: binding.version, text: 'first task', mode: 'prompt',
      model: { provider: 'deepseek', modelId: 'deepseek-v4-flash' }, thinkingLevel: 'high',
    })
    const setModel = h.commands.find((item) => item.command.type === 'set_model')!
    assert.deepEqual(setModel.command, { type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-flash' })
    const setThinking = h.commands.find((item) => item.command.type === 'set_thinking_level')!
    assert.deepEqual(setThinking.command, { type: 'set_thinking_level', level: 'high' })
    const prompt = h.commands.find((item) => item.command.type === 'prompt')!
    assert.ok(h.commands.indexOf(setModel) < h.commands.indexOf(prompt), 'set_model lands before the prompt')
    assert.ok(h.commands.indexOf(setThinking) < h.commands.indexOf(prompt), 'set_thinking_level lands before the prompt')
    // A busy runtime steers without applying any config.
    h.setStreaming(true)
    h.commands.length = 0
    await h.invoke(QUICK_CHAT_CHANNELS.submit, { version: binding.version, text: 'race', mode: 'prompt', model: { provider: 'deepseek', modelId: 'deepseek-v4-flash' } })
    assert.equal(h.commands.some((item) => item.command.type === 'set_model'), false, 'a steer never smuggles a model change')
    assert.equal(h.commands.some((item) => item.command.type === 'steer'), true)
    h.setStreaming(false)
  })
})

test('submit rejects a failed set_model with the engine error and never sends the prompt', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.submit, {
      version: binding.version, text: 'first task', mode: 'prompt', model: { provider: 'deepseek', modelId: 'nope' },
    }), { message: 'model not found' })
    assert.equal(h.commands.some((item) => item.command.type === 'prompt'), false, 'no prompt without a confirmed model')
    // The draft is preserved: the controller keeps it because the send failed.
  })
})

test('setRuntimeModel and setRuntimeThinking are refused while stopped, busy, or awaiting approval', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    // Busy activity.
    h.wm.setSessionRuntimeActivity(h.alpha.runtimeId, 'working')
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.setRuntimeModel, { version: binding.version, provider: 'deepseek', modelId: 'deepseek-v4-flash' }), { message: /Could not switch/i })
    h.wm.setSessionRuntimeActivity(h.alpha.runtimeId, null)
    // A held approval.
    const manager = h.wm.getSessionRuntimeManager(h.alpha.runtimeId)!
    manager.emit('event', { type: 'extension_ui_request', id: 'hold-1', method: 'confirm', message: 'proceed?', timeout: 60_000 })
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.setRuntimeThinking, { version: binding.version, level: 'high' }), { message: /Could not switch/i })
    // The request is still held.
    const snapshot = await h.invoke(QUICK_CHAT_CHANNELS.snapshot, binding.version) as QuickChatSnapshot
    assert.equal(snapshot.request?.id, 'hold-1')
    // A stopped runtime.
    manager.getStatus = () => ({ status: 'stopped', pid: null, error: null })
    await assert.rejects(h.invoke(QUICK_CHAT_CHANNELS.setRuntimeModel, { version: binding.version, provider: 'deepseek', modelId: 'deepseek-v4-flash' }), { message: /Could not switch/i })
  })
})

test('an idle running session switches its model through the bound manager', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    const result = await h.invoke(QUICK_CHAT_CHANNELS.setRuntimeModel, { version: binding.version, provider: 'deepseek', modelId: 'deepseek-v4-flash' })
    assert.ok(result && typeof result === 'object' && 'success' in result && result.success === true)
    const setModel = h.commands.find((item) => item.command.type === 'set_model')!
    assert.deepEqual(setModel.command, { type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-flash' })
  })
})

test('listModels uses the bound running manager catalog without spawning a query process', async () => {
  await withBridge(async (h) => {
    const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
    const manager = h.wm.getSessionRuntimeManager(binding.runtime.runtimeId)!
    const started: unknown[] = []
    manager.start = async (...args: unknown[]) => { started.push(args); return { status: 'running', pid: 999, error: null } as never }
    const models = await h.invoke(QUICK_CHAT_CHANNELS.listModels) as Array<{ provider: string; id: string }>
    assert.deepEqual(models, [{ provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }])
    assert.equal(started.length, 0, 'a live bound runtime answers the catalog directly')
  })
})


test('saved OMP tasks remain selectable through a project alias after popup runtimes are gone', async () => {
  await withBridge(async (h) => {
    const root = h.wm.getActiveWorkspace()!.path
    const project = join(root, 'physical-project')
    const alias = join(root, 'project-alias')
    await mkdir(project)
    await symlink(project, alias, 'junction')
    const workspace = await h.wm.createWorkspace('Alias', alias, { activate: false })
    const saved = { pi: process.env.PI_CODING_AGENT_DIR, omp: process.env.OMP_CODING_AGENT_DIR }
    process.env.PI_CODING_AGENT_DIR = join(root, 'pi-store')
    process.env.OMP_CODING_AGENT_DIR = join(root, 'omp-store')
    try {
      const [directory] = await engineProjectSessionDirs('omp', alias)
      await mkdir(directory, { recursive: true })
      const sessionPath = join(directory, 'alias-session.jsonl')
      await writeFile(sessionPath, [
        { type: 'title', title: 'Alias task' },
        { type: 'session', version: 3, id: 'alias-task', cwd: await realpath(project) },
        { type: 'message', message: { role: 'user', content: 'Continue this independent task', timestamp: 1 } },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      const context = await h.invoke(QUICK_CHAT_CHANNELS.context) as QuickChatContext
      assert.equal(context.sessions.find((session) => session.path === sessionPath)?.projectPath, alias)
      assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, h.beta.runtimeId)
      const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { workspaceId: workspace.id, sessionPath }) as QuickChatBinding
      assert.equal(binding.runtime.workspaceId, workspace.id)
      assert.equal(binding.runtime.sessionPath, sessionPath)
      assert.equal(h.wm.getActiveSessionRuntime()?.runtimeId, h.beta.runtimeId)
    } finally {
      for (const [key, value] of [['PI_CODING_AGENT_DIR', saved.pi], ['OMP_CODING_AGENT_DIR', saved.omp]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

test('pickAttachment reads selected files and submit forwards images to the engine', async () => {
  await withBridge(async (h) => {
    const root = h.wm.getActiveWorkspace()!.path
    const testFile = join(root, 'attached.txt')
    await writeFile(testFile, 'Hello attached file')
    pickerResult.canceled = false
    pickerResult.filePaths = [testFile]
    try {
      const picked = await h.invoke(QUICK_CHAT_CHANNELS.pickAttachment) as Array<{ kind: string; name: string; content?: string }>
      assert.equal(picked.length, 1)
      assert.equal(picked[0].kind, 'text')
      assert.equal(picked[0].name, 'attached.txt')
      assert.equal(picked[0].content, 'Hello attached file')

      const binding = await h.invoke(QUICK_CHAT_CHANNELS.select, { runtimeId: h.alpha.runtimeId }) as QuickChatBinding
      await h.invoke(QUICK_CHAT_CHANNELS.submit, {
        version: binding.version,
        text: 'Prompt with image',
        mode: 'prompt',
        images: [{ type: 'image', mimeType: 'image/png', data: 'B64PNG' }],
      })
      const promptCmd = h.commands.find((c) => c.command.type === 'prompt')
      assert.ok(promptCmd, 'prompt command sent')
      assert.equal(stripInjectedPreamble(String((promptCmd?.command as Record<string, unknown>).message)), 'Prompt with image')
      assert.deepEqual((promptCmd?.command as Record<string, unknown>).images, [{ type: 'image', mimeType: 'image/png', data: 'B64PNG' }])
    } finally {
      pickerResult.canceled = true
      pickerResult.filePaths = []
    }
  })
})
