import { ipcMain } from 'electron'
import { setPiExecutableOverride } from '../pi-rpc-manager'
import { WorkspaceManager } from '../workspace-manager'
import { getGuiDataPath } from '../app-data-paths'
import type { AppSettings } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import { shortcutProblem } from '../../shared/keyboard-shortcuts'
import { availableLanguages } from '../../shared/i18n'
import { normalizeStoredSettings } from '../../shared/app-settings'
import { applyLanguageSetting, getI18nEnvironment, isPseudoLanguageEnabled } from '../i18n'
import { applyRunOnStartup } from '../startup-launch'
import { setTrayEnabled } from '../tray-manager'
import { applyKeepAwake, getKeepAwakeStatus } from '../keep-awake-service'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { isObject } from './validation'
import { appLog } from '../app-log'
import type { IpcContext } from './context'

// ─── App Settings Persistence ────────────────────────────────────────────────

const SETTINGS_FILE_NAME = 'settings.json'

/** Also consumed by the diagnostics report. */
export function getSettingsPath(): string {
  return getGuiDataPath(SETTINGS_FILE_NAME)
}

export async function loadAppSettings(workspaceManager: WorkspaceManager): Promise<AppSettings> {
  try {
    const settingsPath = getSettingsPath()
    if (existsSync(settingsPath)) {
      const data = await readFile(settingsPath, 'utf-8')
      return normalizeStoredSettings(JSON.parse(data), availableLanguages(isPseudoLanguageEnabled()))
    }
  } catch {
    // Fall through to defaults
  }

  return {
    ...DEFAULT_SETTINGS,
    defaultCwd: workspaceManager.getActiveWorkspace()?.path ?? (process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()),
  }
}

export async function saveAppSettings(settings: Partial<AppSettings>): Promise<void> {
  const settingsPath = getSettingsPath()
  const dir = join(settingsPath, '..')

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  // Merge with existing
  let existing: AppSettings = { ...DEFAULT_SETTINGS }
  try {
    if (existsSync(settingsPath)) {
      const data = await readFile(settingsPath, 'utf-8')
      existing = { ...DEFAULT_SETTINGS, ...JSON.parse(data) }
    }
  } catch {
    // Use defaults
  }

  const merged = { ...existing, ...settings }
  if ('shortcuts' in settings) {
    if (!settings.shortcuts || typeof settings.shortcuts !== 'object' || Array.isArray(settings.shortcuts)) {
      throw new Error('Invalid keyboard shortcuts')
    }
    const problem = shortcutProblem(settings.shortcuts, process.platform)
    if (problem) throw new Error(`Invalid keyboard shortcut: ${problem.action} (${problem.kind})`)
  }
  try {
    await writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8')
  } catch (err) {
    // Still propagate to the caller (the Settings panel surfaces it); the log
    // keeps a trace for diagnostics in packaged builds.
    appLog.error('settings', 'Failed to save settings.json', err)
    throw err
  }
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx

  // ─── Settings ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, async () => {
    return loadAppSettings(workspaceManager)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SAVE, async (_event, settings: unknown) => {
    if (!isObject(settings)) throw new Error('settings must be an object')
    await saveAppSettings(settings as Partial<AppSettings>)
    // Reflect a "run on startup" change to the OS immediately (login item on
    // macOS/Windows, autostart entry on Linux). Only applied when the field is
    // part of this save to avoid redundant OS writes.
    if ('runOnStartup' in settings) {
      await applyRunOnStartup(Boolean((settings as Partial<AppSettings>).runOnStartup))
    }
    // Reflect a "minimize to tray" change immediately: create/destroy the tray
    // icon so the close behavior matches the new setting without a restart.
    if ('minimizeToTrayOnClose' in settings) {
      setTrayEnabled(Boolean((settings as Partial<AppSettings>).minimizeToTrayOnClose))
    }
    // Reflect a "keep awake" change immediately: take or release the sleep
    // block so the new setting applies without a restart. Awaited so the
    // status the Settings panel reads next is already the new one.
    if ('keepSystemAwake' in settings) {
      await applyKeepAwake(Boolean((settings as Partial<AppSettings>).keepSystemAwake))
    }
    // Re-resolve the Pi binary so a corrected executable path or explicit engine
    // takes effect on the next runtime start without relying on filename sniffing.
    const updated = await loadAppSettings(workspaceManager)
    if ('piExecutablePath' in settings || 'piEngine' in settings) {
      setPiExecutableOverride(updated.piExecutablePath, updated.piEngine)
    }
    if ('language' in settings) {
      applyLanguageSetting(updated.language)
    }
    return updated
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_KEEP_AWAKE_STATUS, () => getKeepAwakeStatus())

  ipcMain.handle(IPC_CHANNELS.I18N_GET_ENVIRONMENT, () => getI18nEnvironment())

  // Reconcile the OS-level "run on startup" state with the saved preference on
  // launch. Self-healing: repairs a stale Linux autostart Exec path after an
  // app update/move and re-asserts the login item on macOS/Windows. Runs in the
  // background so a failure never blocks handler registration.
  void loadAppSettings(workspaceManager)
    .then((settings) => applyRunOnStartup(settings.runOnStartup))
    .catch((err) => console.error('[startup] Failed to reconcile run-on-startup:', err))
}
