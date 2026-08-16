import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readAttachment } from '../attachment-reader'
import { isAuthorizedAttachmentPath } from '../path-authorization'
import { assertTrustedSender, isString } from './validation'
import type { IpcContext } from './context'

export function registerFileHandlers(ctx: IpcContext): void {
  const { workspaceManager, approvedAttachmentPaths } = ctx

  // ─── File Operations ────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.FILE_TREE, async (_event, maxDepth?: unknown) => {
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.getFileTree(typeof maxDepth === 'number' ? maxDepth : 4)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH, async (_event, query: unknown) => {
    if (!isString(query)) throw new Error('query must be a string')
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.searchFiles(query)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH_CONTENT, async (_event, query: unknown) => {
    if (!isString(query)) throw new Error('query must be a string')
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.searchContent(query)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, filePath: unknown) => {
    if (!isString(filePath)) throw new Error('filePath must be a string')
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.readFileContent(filePath)
  })

  // Reads a user-selected attachment by absolute path (chosen via the native
  // open dialog, so it may live outside the workspace).
  ipcMain.handle(IPC_CHANNELS.FILE_READ_ATTACHMENT, async (_event, filePath: unknown) => {
    if (!isString(filePath)) throw new Error('filePath must be a string')
    const workspaceRoot = workspaceManager.getActiveWorkspace()?.path ?? null
    if (!isAuthorizedAttachmentPath(filePath, { workspaceRoot, approvedPaths: approvedAttachmentPaths })) {
      throw new Error('Attachment path is not permitted')
    }
    return readAttachment(filePath)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_WRITE, async (event, filePath: unknown, content: unknown) => {
    assertTrustedSender(event)
    if (!isString(filePath)) throw new Error('filePath must be a string')
    if (!isString(content)) throw new Error('content must be a string')
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    await fs.writeFileContent(filePath, content)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DIFF, async (_event, filePath?: unknown) => {
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.getFileDiff(isString(filePath) ? filePath : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_STAGED_DIFF, async (_event, filePath?: unknown) => {
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.getStagedDiff(isString(filePath) ? filePath : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, async () => {
    const fs = workspaceManager.getActiveFileService()
    // No active workspace (e.g. the home screen before any workspace is opened)
    // is an expected state, not an error — report no changes rather than throwing
    // (which Electron would log as an unhandled handler error every poll).
    if (!fs) return {}
    const statusMap = await fs.getGitStatus()
    // Convert Map to plain object for IPC
    const result: Record<string, unknown> = {}
    for (const [key, value] of statusMap) {
      result[key] = value
    }
    return result
  })

  ipcMain.handle(IPC_CHANNELS.GIT_BRANCH, async () => {
    const fs = workspaceManager.getActiveFileService()
    // No active workspace: report "no branch" rather than throwing (matches the
    // Promise<string | null> contract; keeps the no-workspace state error-free).
    if (!fs) return null
    return fs.getGitBranch()
  })
}
