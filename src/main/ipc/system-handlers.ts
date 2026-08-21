import { ipcMain, dialog, shell, app } from 'electron'
import type { ActivityStatsResult } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { activityStatsStore } from '../activity-stats'
import { stat } from 'fs/promises'
import { resolve } from 'path'
import { isString, isObject } from './validation'
import type { IpcContext } from './context'

export function registerSystemHandlers(ctx: IpcContext): void {
  const { approvedAttachmentPaths } = ctx

  // ─── System ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_DIALOG, async (_event, options?: unknown) => {
    // Default to directory selection for back-compat with workspace pickers.
    const mode = isObject(options) && (options.mode === 'file' || options.mode === 'either')
      ? options.mode
      : 'directory'
    const pickFile = mode === 'file'
    const dialogOptions: Electron.OpenDialogOptions = {
      properties: mode === 'file'
        ? ['openFile']
        : mode === 'either'
          ? ['openFile', 'openDirectory']
          : ['openDirectory'],
    }
    if (isObject(options)) {
      if (isString(options.title)) dialogOptions.title = options.title
      if (Array.isArray(options.filters)) {
        dialogOptions.filters = options.filters as Electron.FileFilter[]
      }
    }
    const result = await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    // Remember file picks so the attachment reader will accept this exact path
    // even when it lives outside the workspace.
    if (pickFile) approvedAttachmentPaths.add(resolve(picked))
    return picked
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_PATH, async (_event, name: unknown) => {
    if (!isString(name)) throw new Error('name must be a string')
    const validPaths = ['home', 'appData', 'userData', 'temp', 'desktop', 'documents'] as const
    if (validPaths.includes(name as (typeof validPaths)[number])) {
      return app.getPath(name as 'home' | 'appData' | 'userData' | 'temp' | 'desktop' | 'documents')
    }
    throw new Error(`Invalid path name: ${name}`)
  })

  /** Classify a filesystem path for drag-drop (folder → open as workspace). */
  ipcMain.handle(IPC_CHANNELS.SYSTEM_PATH_KIND, async (_event, filePath: unknown) => {
    if (!isString(filePath) || filePath.trim().length === 0) {
      return { exists: false, isDirectory: false }
    }
    try {
      const st = await stat(filePath)
      return { exists: true, isDirectory: st.isDirectory() }
    } catch {
      return { exists: false, isDirectory: false }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, async (_event, url: unknown) => {
    if (!isString(url)) throw new Error('url must be a string')
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      throw new Error('Only http(s) URLs are allowed')
    }
    await shell.openExternal(url)
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_VERSION, async () => {
    return app.getVersion()
  })

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_GET_STATS, async (): Promise<ActivityStatsResult> => {
    return activityStatsStore.computeStats()
  })
}
