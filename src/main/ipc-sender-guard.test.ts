import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IpcMain, WebContents } from 'electron'
import { isAppWindowSender, restrictIpcToAppWindows, UNAUTHORIZED_IPC_SENDER_MESSAGE, type AppSenderSources } from './ipc-sender-guard'

const CHANNEL = 'test:channel'
const RESULT = 'result'

function fakeSender(type: string, session: object): WebContents {
  return { getType: () => type, session } as unknown as WebContents
}

const appSession = {}
const previewSession = {}
const browserPaneSession = {}
const mainContents = fakeSender('window', appSession)
const quickChatContents = fakeSender('window', appSession)
const guestContents = fakeSender('webview', browserPaneSession)
const otherWindowContents = fakeSender('window', appSession)
const windowInGuestSession = fakeSender('window', previewSession)

const sources: AppSenderSources = {
  appWindowContents: () => [mainContents, quickChatContents, null],
  guestSessions: [previewSession, browserPaneSession],
}

test('the main window and the Quick Chat window are app senders', () => {
  assert.equal(isAppWindowSender(mainContents, sources), true)
  assert.equal(isAppWindowSender(quickChatContents, sources), true)
})

test('a webview guest, a guest partition and any other window are refused', () => {
  assert.equal(isAppWindowSender(guestContents, sources), false)
  assert.equal(isAppWindowSender(windowInGuestSession, sources), false)
  assert.equal(isAppWindowSender(otherWindowContents, sources), false)
})

test('a webview guest is refused even when it is listed as an app window', () => {
  const listed: AppSenderSources = { appWindowContents: () => [guestContents], guestSessions: [] }
  assert.equal(isAppWindowSender(guestContents, listed), false)
})

type Listener = (event: { sender: WebContents }, ...args: unknown[]) => unknown

function fakeIpc(): { ipc: IpcMain; handlers: Map<string, Listener>; listeners: Map<string, Listener> } {
  const handlers = new Map<string, Listener>()
  const listeners = new Map<string, Listener>()
  const ipc = {
    handle: (channel: string, listener: Listener) => { handlers.set(channel, listener) },
    on(channel: string, listener: Listener) {
      listeners.set(channel, listener)
      return this
    },
  }
  return { ipc: ipc as unknown as IpcMain, handlers, listeners }
}

const isAllowed = (sender: WebContents): boolean => isAppWindowSender(sender, sources)

test('a handled channel refuses a guest sender and serves the app windows', async () => {
  const { ipc, handlers } = fakeIpc()
  restrictIpcToAppWindows(ipc, isAllowed)
  ipc.handle(CHANNEL, (_event, value: unknown) => `${RESULT}:${String(value)}`)
  const handler = handlers.get(CHANNEL)!
  assert.throws(() => handler({ sender: guestContents }, 1), { message: UNAUTHORIZED_IPC_SENDER_MESSAGE })
  assert.equal(await handler({ sender: mainContents }, 1), `${RESULT}:1`)
  assert.equal(await handler({ sender: quickChatContents }, 2), `${RESULT}:2`)
})

test('a listened channel drops a guest message and passes app window messages', () => {
  const { ipc, listeners } = fakeIpc()
  restrictIpcToAppWindows(ipc, isAllowed)
  const received: unknown[] = []
  assert.equal(ipc.on(CHANNEL, (_event, value: unknown) => { received.push(value) }), ipc)
  const listener = listeners.get(CHANNEL)!
  listener({ sender: guestContents }, 'guest')
  listener({ sender: windowInGuestSession }, 'preview')
  listener({ sender: mainContents }, 'main')
  listener({ sender: quickChatContents }, 'quick')
  assert.deepEqual(received, ['main', 'quick'])
})
