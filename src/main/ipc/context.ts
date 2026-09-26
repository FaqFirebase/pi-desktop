import { app, BrowserWindow } from 'electron'
import { PiRpcManager } from '../pi-rpc-manager'
import { WorkspaceManager } from '../workspace-manager'
import { SessionTagManager } from '../session-tags'
import { ArchivedSessionsManager } from '../archived-sessions'
import { TerminalService } from '../terminal-service'
import { WorkspaceTerminals } from '../workspace-terminals'
import { NotesManager } from '../notes-manager'

export interface IpcContext {
  workspaceManager: WorkspaceManager
  broadcast(channel: string, data: unknown): void
  getActivePi(): PiRpcManager
  approvedAttachmentPaths: Set<string>
  tagManager: SessionTagManager
  archivedSessions: ArchivedSessionsManager
  notesManager: NotesManager
  terminalService: WorkspaceTerminals
}

export function createIpcContext(workspaceManager: WorkspaceManager): IpcContext {
  const tagManager = new SessionTagManager()
  const archivedSessions = new ArchivedSessionsManager()
  const terminalService = new WorkspaceTerminals(() => new TerminalService())
  app.on('will-quit', () => terminalService.stopAll())
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

  // Helper: broadcast to all renderer windows
  function broadcast(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
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
  }
}
