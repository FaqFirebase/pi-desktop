import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { setImmediate as flush } from 'node:timers/promises'
import type { IpcContext } from './context'
import type { registerModelHandlers as RegisterModelHandlers } from './model-handlers'
import type { ModelInfo } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import type { QuickChatApi, QuickChatBinding, QuickChatUpdate } from '../../shared/quick-chat'

const require = createRequire(import.meta.url)
// Load the other process's implementation at runtime without merging its
// source tree into main's composite TypeScript project.
const { QuickChatController } = require('../../renderer/src/quick-chat/controller') as {
  QuickChatController: new (api: QuickChatApi) => {
    start(): void
    dispose(): void
    getState(): { binding: QuickChatBinding | null; model: ModelInfo | null }
  }
}
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const electronPath = require.resolve('electron')
require('electron')
require.cache[electronPath]!.exports = {
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}
const { registerModelHandlers } = require('./model-handlers') as { registerModelHandlers: typeof RegisterModelHandlers }
let receive: (update: QuickChatUpdate) => void = () => {}

function model(id: string): ModelInfo {
  return { id, name: id, provider: 'provider', api: 'test', baseUrl: '', reasoning: true, input: ['text'], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}

test('a model change completing after main switches to B still refreshes the popup bound to A', async () => {
  const binding: QuickChatBinding = { version: 1, runtime: { runtimeId: 'A', workspaceId: 'workspace', sessionPath: '/a.jsonl', sessionId: 'a', status: 'running', pid: 1, error: null, activity: null, active: false } }
  let currentModel = model('old')
  // The project's ES2022 library does not expose Promise.withResolvers.
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const a = { id: 'A', sendCommand: async () => { await pending; currentModel = model('new'); return { success: true } } }
  const b = { id: 'B' }
  let active: { id: string } = a
  const api = {
    onUpdate: (callback: typeof receive) => { receive = callback; return () => { receive = () => {} } },
    getContext: async () => ({ pinned: false, binding, runtimes: [binding.runtime], workspaces: [], sessions: [], runtimeUpdatedAt: {}, defaultWorkspaceId: null, settings: { ...DEFAULT_SETTINGS }, i18nEnvironment: { systemLanguages: ['en'], pseudoLanguageEnabled: false }, themes: [] }),
    getSnapshot: async () => ({ binding, messages: [], streaming: null, request: null, model: currentModel, thinkingLevel: 'high', permissionMode: null }),
  } as unknown as QuickChatApi
  const popup = new QuickChatController(api)
  registerModelHandlers({
    getActivePi: () => active,
    workspaceManager: {
      runtimeIdFor: (manager: { id: string }) => manager.id,
      notifySessionRuntimeState: (runtimeId: string) => {
        receive({ type: 'runtime-state', runtimeId })
      },
    },
  } as unknown as IpcContext)
  popup.start()
  try {
    await flush()
    assert.equal(popup.getState().model?.id, 'old')
    const changing = handlers.get(IPC_CHANNELS.MODEL_SET)!({}, 'provider', 'new')
    active = b
    finish()
    await changing
    await flush()
    assert.equal(popup.getState().binding?.runtime.runtimeId, 'A')
    assert.equal(popup.getState().model?.id, 'new')
  } finally {
    popup.dispose()
  }
})
