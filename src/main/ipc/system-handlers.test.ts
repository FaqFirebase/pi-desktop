import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { IpcContext } from './context'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'

type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const approvedAttachmentPaths = new Set<string>()
const dialogCalls: Electron.OpenDialogOptions[] = []
let nextDialogResult: Electron.OpenDialogReturnValue = { canceled: true, filePaths: [] }

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const electronModule = require.cache[electronPath]!
const originalExports = electronModule.exports

before(async () => {
  electronModule.exports = {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    dialog: {
      showOpenDialog: async (options: Electron.OpenDialogOptions) => {
        dialogCalls.push(options)
        return nextDialogResult
      },
    },
    shell: {},
    app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  }
  const { registerSystemHandlers } = await import('./system-handlers')
  registerSystemHandlers({ approvedAttachmentPaths } as unknown as IpcContext)
})

after(() => {
  electronModule.exports = originalExports
})

beforeEach(() => {
  approvedAttachmentPaths.clear()
  dialogCalls.length = 0
})

const FILTERS = [{ name: 'Images', extensions: ['png'] }]

test('the attachment picker allows several files and approves every picked path', async () => {
  const picked = ['/shots/one.png', '/shots/two.png']
  nextDialogResult = { canceled: false, filePaths: picked }

  const paths = await handlers.get(IPC_CHANNELS.SYSTEM_OPEN_ATTACHMENT_DIALOG)!(null, { title: 'Attach file', filters: FILTERS })

  assert.deepEqual(paths, picked)
  assert.deepEqual(dialogCalls, [{ properties: ['openFile', 'multiSelections'], title: 'Attach file', filters: FILTERS }])
  assert.deepEqual([...approvedAttachmentPaths], picked.map((path) => resolve(path)))
})

test('a cancelled attachment picker returns no paths and approves nothing', async () => {
  nextDialogResult = { canceled: true, filePaths: ['/shots/ignored.png'] }

  assert.deepEqual(await handlers.get(IPC_CHANNELS.SYSTEM_OPEN_ATTACHMENT_DIALOG)!(null), [])
  assert.equal(approvedAttachmentPaths.size, 0)
})

test('the path dialog returns one path and never widens the attachment allowlist', async () => {
  nextDialogResult = { canceled: false, filePaths: ['/opt/pi', '/opt/other'] }

  assert.equal(await handlers.get(IPC_CHANNELS.SYSTEM_OPEN_DIALOG)!(null, { mode: 'either' }), '/opt/pi')
  // The removed 'file' mode is no longer a way into the allowlist: it falls back to a folder picker.
  assert.equal(await handlers.get(IPC_CHANNELS.SYSTEM_OPEN_DIALOG)!(null, { mode: 'file' }), '/opt/pi')
  assert.deepEqual(dialogCalls[1].properties, ['openDirectory'])
  assert.equal(approvedAttachmentPaths.size, 0)
})
