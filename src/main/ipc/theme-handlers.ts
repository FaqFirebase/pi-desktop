import { ipcMain, dialog, BrowserWindow } from 'electron'
import { getGuiDataDir } from '../app-data-paths'
import { toWindowBackgroundColor } from '../window-background'
import { listUserThemes, saveUserTheme, deleteUserTheme, installThemeFromUrl, fetchGalleryThemes, fetchGalleryImage } from '../theme-store'
import {
  validateThemeFile, themeIdFromName, MAX_THEME_FILE_BYTES, type ThemeFile,
} from '../../shared/theme/theme-file'
import type {
  ThemesListResult,
  UserThemeRecord,
  ThemeImportResult,
  ThemeExportResult,
  ThemeGalleryResult,
  ThemeGalleryImageResult,
} from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readFile, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { isString } from './validation'
import { t } from '../../shared/i18n'

const THEMES_DIR_NAME = 'themes'
function themeFileFilter(): Electron.FileFilter {
  return { name: t('dialogs.theme.fileFilterName'), extensions: ['json'] }
}

export function themesDir(): string {
  return join(getGuiDataDir(), THEMES_DIR_NAME)
}

/** `onThemesChanged` gets the new list after each save, delete or install. */
export function registerThemeHandlers(onThemesChanged: (themes: UserThemeRecord[]) => void): void {
  async function announceThemes(): Promise<void> {
    onThemesChanged((await listUserThemes(themesDir())).themes)
  }

  // ─── Themes ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.THEMES_LIST, async (): Promise<ThemesListResult> => {
    return listUserThemes(themesDir())
  })

  ipcMain.handle(IPC_CHANNELS.THEMES_SAVE, async (_event, file: unknown, existingId: unknown) => {
    if (existingId !== undefined && !isString(existingId)) {
      throw new Error('existingId must be a string')
    }
    const saved = await saveUserTheme(themesDir(), file as ThemeFile, existingId)
    await announceThemes()
    return saved
  })

  // Unsupported color forms are ignored rather than thrown: a wrong native
  // background is cosmetic and only visible at window edges.
  ipcMain.handle(IPC_CHANNELS.THEMES_SET_WINDOW_BACKGROUND, (event, color: unknown) => {
    const background = toWindowBackgroundColor(color)
    if (background) BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(background)
  })

  ipcMain.handle(IPC_CHANNELS.THEMES_DELETE, async (_event, id: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    await deleteUserTheme(themesDir(), id)
    await announceThemes()
  })

  ipcMain.handle(IPC_CHANNELS.THEMES_INSTALL_URL, async (_event, url: unknown): Promise<ThemeImportResult> => {
    if (!isString(url)) throw new Error('url must be a string')
    try {
      const { id, file } = await installThemeFromUrl(themesDir(), url)
      await announceThemes()
      return { ok: true, theme: { id, file } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.THEMES_EXPORT, async (_event, file: unknown): Promise<ThemeExportResult> => {
    let theme: ThemeFile
    try {
      theme = validateThemeFile(file)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const defaultName = `${themeIdFromName(theme.name) || 'theme'}.json`
    const result = await dialog.showSaveDialog({
      title: t('dialogs.theme.exportTitle'),
      defaultPath: defaultName,
      filters: [themeFileFilter()],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      await writeFile(result.filePath, JSON.stringify(theme, null, 2))
      return { ok: true }
    } catch (error) {
      console.error('Failed to write exported theme file:', error)
      return {
        ok: false,
        error: error instanceof Error ? error.message : t('errors.theme.exportWriteFailed', { path: result.filePath }),
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.THEMES_IMPORT, async (): Promise<ThemeImportResult> => {
    const result = await dialog.showOpenDialog({
      title: t('dialogs.theme.importTitle'),
      properties: ['openFile'],
      filters: [themeFileFilter()],
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const filePath = result.filePaths[0]
      const { size } = await stat(filePath)
      if (size > MAX_THEME_FILE_BYTES) {
        return { ok: false, error: t('errors.theme.fileTooLarge', { limit: MAX_THEME_FILE_BYTES }) }
      }
      const file = validateThemeFile(JSON.parse(await readFile(filePath, 'utf8')))
      const { id } = await saveUserTheme(themesDir(), file)
      await announceThemes()
      return { ok: true, theme: { id, file } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.THEMES_GALLERY_LIST, async (): Promise<ThemeGalleryResult> => {
    try {
      const themes = await fetchGalleryThemes()
      return { ok: true, themes }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.THEMES_GALLERY_IMAGE, async (_event, url: unknown): Promise<ThemeGalleryImageResult> => {
    if (!isString(url)) return { ok: false, error: 'url must be a string' }
    try {
      const { dataUri } = await fetchGalleryImage(url)
      return { ok: true, dataUri }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
