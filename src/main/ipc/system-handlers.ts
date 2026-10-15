import { ipcMain, dialog, shell, app } from 'electron'
import type { ActivityStatsResult, OpenDialogOptions } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { activityStatsStore } from '../activity-stats'
import { stat } from 'fs/promises'
import { resolve } from 'path'
import { isString, isObject } from './validation'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

type OpenDialogMode = NonNullable<OpenDialogOptions['mode']>

/**
 * Only macOS shows one dialog that accepts a file OR a directory. Windows and
 * Linux silently turn `['openFile', 'openDirectory']` into a directory-only
 * selector, which would take the file half of `mode: 'either'` away from every
 * platform this app actually ships to. Degrade to the file half there instead:
 * a directory is reachable by asking for `mode: 'directory'`, an executable
 * inside one is not reachable from a directory picker at all.
 */
const SUPPORTS_COMBINED_DIALOG = process.platform === 'darwin'

function dialogProperties(mode: OpenDialogMode): Electron.OpenDialogOptions['properties'] {
  if (mode === 'directory') return ['openDirectory']
  if (SUPPORTS_COMBINED_DIALOG) return ['openFile', 'openDirectory']
  return ['openFile']
}

/** Title and filters shared by every renderer-requested dialog. */
function dialogTextOptions(options: unknown): Pick<Electron.OpenDialogOptions, 'title' | 'filters'> {
  if (!isObject(options)) return {}
  return {
    ...(isString(options.title) && { title: options.title }),
    ...(Array.isArray(options.filters) && { filters: options.filters as Electron.FileFilter[] }),
  }
}

export function registerSystemHandlers(ctx: IpcContext): void {
  const { approvedAttachmentPaths } = ctx

  // ─── System ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_DIALOG, async (_event, options?: unknown) => {
    // Default to directory selection for back-compat with workspace pickers.
    // A path chosen here is never added to the attachment allowlist: a path
    // picked for a settings field is never read back as file content.
    const mode: OpenDialogMode = isObject(options) && options.mode === 'either' ? 'either' : 'directory'
    const result = await dialog.showOpenDialog({ properties: dialogProperties(mode), ...dialogTextOptions(options) })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_ATTACHMENT_DIALOG, async (_event, options?: unknown) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      ...dialogTextOptions(options),
    })
    if (result.canceled) return []
    // Remember file picks so the attachment reader will accept these exact
    // paths even when they live outside the workspace.
    for (const picked of result.filePaths) approvedAttachmentPaths.add(resolve(picked))
    return result.filePaths
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
      throw new Error(t('errors.system.externalUrlHttpOnly'))
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
