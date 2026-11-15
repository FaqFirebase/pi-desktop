import { app, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { appLog } from '../app-log'
import { isWithinSessionRoots } from '../pi-paths'
import { JSONL_EXTENSION } from '../session-paths'
import { isString } from './validation'
import type { IpcContext } from './context'
import type { WindowControls } from './workspace-activity-wiring'

/**
 * Feeds the unread tracker the two on-screen signals: focus of the main
 * window (from Electron) and the session the main view shows (from the
 * renderer), plus runtime snapshots, which carry the file of a new session.
 * Turn ends reach it from the workspace activity wiring.
 */
export function wireSessionUnread(ctx: IpcContext, windowControls: WindowControls): void {
  const { unreadSessions, workspaceManager } = ctx

  workspaceManager.onSessionRuntime((runtime) => {
    void unreadSessions.handleRuntimeSession(runtime).catch((err) => {
      appLog.warn('sessions', 'Failed to record an unread session', err)
    })
  })

  app.on('browser-window-focus', (_event, window) => {
    if (window !== windowControls.getWindow()) return
    void unreadSessions.handleMainWindowFocus().catch((err) => {
      appLog.warn('sessions', 'Failed to clear an unread session', err)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_UNREAD, async () => unreadSessions.getAll())

  ipcMain.handle(IPC_CHANNELS.SESSION_SET_VISIBLE, async (event, sessionPath: unknown): Promise<void> => {
    ctx.assertMainSender(event)
    const isSessionFile = isString(sessionPath) && sessionPath.endsWith(JSONL_EXTENSION) && isWithinSessionRoots(sessionPath)
    if (sessionPath !== null && !isSessionFile) {
      throw new Error('sessionPath must be a session file or null')
    }
    await unreadSessions.setVisibleSession(sessionPath)
  })
}
