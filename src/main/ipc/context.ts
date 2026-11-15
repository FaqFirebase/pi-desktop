import { BrowserWindow, globalShortcut, type IpcMainInvokeEvent } from 'electron'
import { PiRpcManager } from '../pi-rpc-manager'
import { WorkspaceManager } from '../workspace-manager'
import { SessionTagManager } from '../session-tags'
import { ArchivedSessionsManager } from '../archived-sessions'
import { SessionTimestampStore } from '../session-timestamp-store'
import { PINNED_SESSIONS_FILE_NAME } from '../pinned-sessions'
import { createSessionUnreadTracker, UNREAD_SESSIONS_FILE_NAME, type SessionUnreadTracker } from '../session-unread'
import { TerminalService } from '../terminal-service'
import { WorkspaceTerminals } from '../workspace-terminals'
import { EDITOR_TERMINAL_KEY_SUFFIX, workspaceTerminalKeys } from '../../shared/terminal-slot'
import { NotesManager } from '../notes-manager'
import { GlobalDictationShortcut } from '../global-dictation-shortcut'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { appLog } from '../app-log'
import { getQuickChatWindow, toggleQuickChatWindow } from '../quick-chat-window'
import { assertTrustedSender } from './validation'

export interface IpcContext {
  workspaceManager: WorkspaceManager
  broadcast(channel: string, data: unknown): void
  getActivePi(): PiRpcManager
  approvedAttachmentPaths: Set<string>
  /** Project folders of listed sessions; open-path actions may act in them. */
  knownSessionFolders: Set<string>
  tagManager: SessionTagManager
  archivedSessions: ArchivedSessionsManager
  pinnedSessions: SessionTimestampStore
  unreadSessions: SessionUnreadTracker
  notesManager: NotesManager
  terminalService: WorkspaceTerminals
  globalDictationShortcut: GlobalDictationShortcut
  quickChatShortcut: GlobalDictationShortcut
  assertMainSender(event: IpcMainInvokeEvent): void
}

export function createIpcContext(workspaceManager: WorkspaceManager, getMainWindow: () => BrowserWindow | null = () => null): IpcContext {
  const tagManager = new SessionTagManager()
  const archivedSessions = new ArchivedSessionsManager()
  const pinnedSessions = new SessionTimestampStore(PINNED_SESSIONS_FILE_NAME)
  const terminalService = new WorkspaceTerminals(() => new TerminalService(), (key) => key.endsWith(EDITOR_TERMINAL_KEY_SUFFIX))
  workspaceManager.onWorkspaceRemoved((workspaceId) => {
    for (const key of workspaceTerminalKeys(workspaceId)) terminalService.stop(key)
  })
  const notesManager = new NotesManager()

  // Absolute paths the user explicitly picked via the native open dialog. The
  // attachment reader will only read these (or files inside the workspace), so a
  // renderer cannot ask it to read arbitrary files by path.
  const approvedAttachmentPaths = new Set<string>()
  const knownSessionFolders = new Set<string>()

  // Helper: get Pi manager for active workspace
  function getActivePi(): PiRpcManager {
    const pi = workspaceManager.getActivePiManager()
    if (!pi) throw new Error('No active workspace or Pi not running')
    return pi
  }

  // Main-only traffic must never leak active-session data or voice control to the popup.
  function broadcast(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed() && win !== getQuickChatWindow()) {
        win.webContents.send(channel, data)
      }
    }
  }

  const unreadSessions = createSessionUnreadTracker({
    store: new SessionTimestampStore(UNREAD_SESSIONS_FILE_NAME),
    isMainWindowFocused: () => {
      const main = getMainWindow()
      return !!main && !main.isDestroyed() && main.isFocused()
    },
    onChange: (map) => broadcast(IPC_CHANNELS.EVENT_UNREAD_SESSIONS, map),
  })

  const globalDictationShortcut = new GlobalDictationShortcut(
    globalShortcut,
    () => broadcast(IPC_CHANNELS.EVENT_VOICE_SHORTCUT, null),
    (accelerator) => appLog.warn('voice', `Could not register the system-wide dictation shortcut ${accelerator}; another app may use it`),
  )
  const quickChatShortcut = new GlobalDictationShortcut(
    globalShortcut,
    toggleQuickChatWindow,
    (accelerator) => appLog.warn('quick-chat', `Could not register the system-wide Quick Chat shortcut ${accelerator}; another app may use it`),
  )

  function assertMainSender(event: IpcMainInvokeEvent): void {
    assertTrustedSender(event)
    const main = getMainWindow()
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Unauthorized main window sender')
    }
  }

  return {
    workspaceManager,
    broadcast,
    getActivePi,
    approvedAttachmentPaths,
    knownSessionFolders,
    tagManager,
    archivedSessions,
    pinnedSessions,
    unreadSessions,
    notesManager,
    terminalService,
    globalDictationShortcut,
    quickChatShortcut,
    assertMainSender,
  }
}
