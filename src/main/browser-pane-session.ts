// Electron rules of the Browser pane partition and its <webview> guests. The
// decisions are in browser-pane-guest.ts and shared/browser-pane.ts; this
// module applies them. index.ts calls hardenBrowserPaneSession once at start
// and watchBrowserPaneGuest for every guest of the partition.

import { session, type Input, type WebContents } from 'electron'
import { BROWSER_PANE_PARTITION } from '../shared/preview-partitions'
import {
  browserPaneKeyAction,
  isBrowserPaneUrl,
  type BrowserPaneGuestEvent,
  type BrowserPaneGuestSignal,
} from '../shared/browser-pane'
import { IPC_CHANNELS } from '../shared/ipc-contracts'
import type { ShortcutKeyEvent } from '../shared/keyboard-shortcuts'
import { browserPanePopupAction, isBlockedBrowserPaneRequest } from './browser-pane-guest'

// Input events that count as the user acting in the page (see browserPanePopupAction).
const USER_INPUT_EVENT_TYPES: ReadonlySet<string> = new Set(['mouseDown', 'rawKeyDown', 'keyDown'])
const KEY_DOWN_INPUT_TYPE = 'keyDown'

function browserPaneSession(): Electron.Session {
  return session.fromPartition(BROWSER_PANE_PARTITION)
}

function sendGuestEvent(contents: WebContents, signal: BrowserPaneGuestSignal): void {
  const event: BrowserPaneGuestEvent = { webContentsId: contents.id, ...signal }
  contents.hostWebContents?.send(IPC_CHANNELS.EVENT_BROWSER_PANE_GUEST, event)
}

/**
 * Lock the partition down before any page loads: top-level loads only for
 * http and https (this also covers the host's loadURL calls and redirects,
 * which will-navigate does not see), no permission is ever granted (camera,
 * microphone, location, notifications, opening custom-scheme links), and no
 * download starts.
 */
export function hardenBrowserPaneSession(): void {
  const paneSession = browserPaneSession()
  paneSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: isBlockedBrowserPaneRequest(details.url, details.resourceType) })
  })
  paneSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  paneSession.setPermissionCheckHandler(() => false)
  paneSession.on('will-download', (event, _item, contents) => {
    event.preventDefault()
    sendGuestEvent(contents, { kind: 'download-refused' })
  })
}

/** True when `contents` is a Browser pane guest (its session is the pane's partition). */
export function isBrowserPaneGuest(contents: WebContents): boolean {
  return contents.session === browserPaneSession()
}

function shortcutKeyEvent(input: Input): ShortcutKeyEvent {
  return {
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    metaKey: input.meta,
    altKey: input.alt,
    shiftKey: input.shift,
    isComposing: input.isComposing,
  }
}

/**
 * The per-guest rules: pop-ups load in the pane only right after a user
 * click or key, navigation stays on http and https, and the pane keys go to
 * the host instead of the page or the app menu while the page has focus.
 */
export function watchBrowserPaneGuest(contents: WebContents): void {
  // No input yet: a pop-up before any click is denied.
  let lastUserInputAt = Number.NEGATIVE_INFINITY
  contents.on('input-event', (_event, input) => {
    if (USER_INPUT_EVENT_TYPES.has(input.type)) lastUserInputAt = Date.now()
  })

  // Replaces the deny-all handler web-contents-created set just before.
  contents.setWindowOpenHandler(({ url }) => {
    if (browserPanePopupAction(url, Date.now() - lastUserInputAt) === 'open-in-pane') void contents.loadURL(url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event) => {
    if (!isBrowserPaneUrl(event.url)) event.preventDefault()
  })
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame && !isBrowserPaneUrl(event.url)) event.preventDefault()
  })

  contents.on('before-input-event', (event, input) => {
    if (input.type !== KEY_DOWN_INPUT_TYPE) return
    const action = browserPaneKeyAction(shortcutKeyEvent(input), process.platform)
    if (!action) return
    // Also keeps the app menu's Reload and Zoom accelerators off this key
    // press, held repeats included; a repeat does not act again.
    event.preventDefault()
    if (!input.isAutoRepeat) sendGuestEvent(contents, { kind: 'key', action })
  })
}
