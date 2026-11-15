import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createRequire } from 'node:module'
import type { IpcContext } from './context'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'

type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const UNTRUSTED_EVENT = { untrusted: true }
const TRUSTED_EVENT = {}

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const electronModule = require.cache[electronPath]!
const originalExports = electronModule.exports

before(async () => {
  electronModule.exports = {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    shell: {},
    app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  }
  const { registerEditorHandlers } = await import('./editor-handlers')
  registerEditorHandlers({
    assertMainSender: (event: unknown) => {
      if (event === UNTRUSTED_EVENT) throw new Error('Unauthorized main window sender')
    },
    workspaceManager: { getWorkspaces: () => [], getActivePanelRoot: () => null, getActiveWorkspace: () => null },
    terminalService: {},
    knownSessionFolders: new Set<string>(),
  } as unknown as IpcContext)
})

after(() => {
  electronModule.exports = originalExports
})

test('open-path checks the main sender before anything else', async () => {
  await assert.rejects(
    async () => handlers.get(IPC_CHANNELS.SYSTEM_OPEN_PATH)!(UNTRUSTED_EVENT, { action: 'reveal', path: '/w/a.ts' }),
    /Unauthorized main window sender/,
  )
})

test('editor detection checks the main sender', async () => {
  await assert.rejects(async () => handlers.get(IPC_CHANNELS.EDITORS_DETECT)!(UNTRUSTED_EVENT, true), /Unauthorized/)
})

test('open-path rejects a bad payload', async () => {
  for (const bad of [null, { action: 'run', path: '/w' }, { action: 'reveal', path: '' }, { action: 'reveal', path: '  ' }, { action: 'editor', path: '/w/a', line: 0 }, { action: 'editor', path: '/w/a', line: 1.5 }, { action: 'editor', path: '/w/a', line: '3' }]) {
    await assert.rejects(async () => handlers.get(IPC_CHANNELS.SYSTEM_OPEN_PATH)!(TRUSTED_EVENT, bad), Error, JSON.stringify(bad))
  }
})

test('open-path refuses a path when no project is open', async () => {
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.SYSTEM_OPEN_PATH)!(TRUSTED_EVENT, { action: 'reveal', path: '/w/a.ts' }),
    { ok: false, refusal: 'outside-roots' },
  )
})
