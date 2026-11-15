import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import type { IpcContext } from './context'
import { IPC_CHANNELS, type GitAvailability } from '../../shared/ipc-contracts'

type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const calls: string[] = []

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const electronModule = require.cache[electronPath]!
const originalElectronExports = electronModule.exports

const piRpcManagerPath = require.resolve('../pi-rpc-manager')
let piRpcManagerModule: NodeModule
let originalPiRpcManagerExports: unknown

let registerGitAvailabilityHandlers: typeof import('./git-availability-handlers').registerGitAvailabilityHandlers
let getGitAvailability: typeof import('./git-availability-handlers').getGitAvailability

before(async () => {
  electronModule.exports = {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  }
  // Stubbed so the test needs no real Pi install or login-shell probe.
  require('../pi-rpc-manager')
  piRpcManagerModule = require.cache[piRpcManagerPath]!
  originalPiRpcManagerExports = piRpcManagerModule.exports
  piRpcManagerModule.exports = { getPiResolution: () => { calls.push('resolution') } }
  ;({ registerGitAvailabilityHandlers, getGitAvailability } = await import('./git-availability-handlers'))
})

after(() => {
  electronModule.exports = originalElectronExports
  piRpcManagerModule.exports = originalPiRpcManagerExports
})

test('the git check refuses a sender that is not the main window', async () => {
  const ctx = { assertMainSender: () => { throw new Error('Unauthorized main window sender') } } as unknown as IpcContext
  registerGitAvailabilityHandlers(ctx)
  await assert.rejects(async () => handlers.get(IPC_CHANNELS.GIT_AVAILABILITY_GET)!({}), /Unauthorized/)
  await assert.rejects(async () => handlers.get(IPC_CHANNELS.GIT_AVAILABILITY_RECHECK)!({}), /Unauthorized/)
})

test('the git check adopts the login-shell PATH before it runs git', async () => {
  const ctx = { assertMainSender: () => {} } as unknown as IpcContext
  registerGitAvailabilityHandlers(ctx)
  const result = await handlers.get(IPC_CHANNELS.GIT_AVAILABILITY_GET)!({}) as GitAvailability
  assert.deepEqual(calls, ['resolution'])
  assert.equal(result.status, 'found')
  assert.equal(await getGitAvailability(), result)
})
