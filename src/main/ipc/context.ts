import { BrowserWindow, globalShortcut, type IpcMainInvokeEvent } from 'electron'
import { PiRpcManager } from '../pi-rpc-manager'
import { WorkspaceManager } from '../workspace-manager'
import { SessionTagManager } from '../session-tags'
import { ArchivedSessionsManager } from '../archived-sessions'
import { TerminalService } from '../terminal-service'
import { WorkspaceTerminals } from '../workspace-terminals'
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
  tagManager: SessionTagManager
  archivedSessions: ArchivedSessionsManager
  notesManager: NotesManager
  terminalService: WorkspaceTerminals
  globalDictationShortcut: GlobalDictationShortcut
  quickChatShortcut: GlobalDictationShortcut
  assertMainSender(event: IpcMainInvokeEvent): void
}

export function createIpcContext(workspaceManager: WorkspaceManager, getMainWindow: () => BrowserWindow | null = () => null): IpcContext {
  const tagManager = new SessionTagManager()
  const archivedSessions = new ArchivedSessionsManager()
  const terminalService = new WorkspaceTerminals(() => new TerminalService())
  workspaceManager.onWorkspaceRemoved((workspaceId) => terminalService.stop(workspaceId))
  const notesManager = new NotesManager()

  // Absolute paths the user explicitly picked via the native open dialog. The
  // attachment reader will only read these (or files inside the workspace), so a
  // renderer cannot ask it to read arbitrary files by path.
  const approvedAttachmentPaths = new Set<string>()

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
    tagManager,
    archivedSessions,
    notesManager,
    terminalService,
    globalDictationShortcut,
    quickChatShortcut,
    assertMainSender,
  }
}
