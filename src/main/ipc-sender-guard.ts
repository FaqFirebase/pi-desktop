import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'

/**
 * IPC from app windows only. Every `ipcMain.handle` and `ipcMain.on` channel
 * serves the main window and the Quick Chat window, and nothing else: a
 * `<webview>` guest (file preview, Browser pane) and any contents in a guest
 * partition are refused before a handler runs. Installed once, before any
 * handler is registered, so a new channel cannot be left out.
 */

/** `WebContents.getType()` of a `<webview>` guest. */
export const GUEST_CONTENTS_TYPE = 'webview'
export const UNAUTHORIZED_IPC_SENDER_MESSAGE = 'Unauthorized IPC sender'

export interface AppSenderSources {
  /** The contents of the main and Quick Chat windows; null while one is closed. */
  appWindowContents(): ReadonlyArray<WebContents | null | undefined>
  /** Sessions of the preview and Browser pane partitions. */
  guestSessions: ReadonlyArray<unknown>
}

export function isAppWindowSender(sender: WebContents, sources: AppSenderSources): boolean {
  if (sender.getType() === GUEST_CONTENTS_TYPE) return false
  if (sources.guestSessions.includes(sender.session)) return false
  return sources.appWindowContents().includes(sender)
}

/** Wraps `handle` and `on` of `ipc`, so each later registration checks its sender first. */
export function restrictIpcToAppWindows(ipc: IpcMain, isAllowed: (sender: WebContents) => boolean): void {
  const handle = ipc.handle.bind(ipc)
  const on = ipc.on.bind(ipc)
  ipc.handle = (channel, listener) => {
    handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isAllowed(event.sender)) throw new Error(UNAUTHORIZED_IPC_SENDER_MESSAGE)
      return listener(event, ...args)
    })
  }
  ipc.on = (channel, listener) => on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
    if (isAllowed(event.sender)) listener(event, ...args)
  })
}
