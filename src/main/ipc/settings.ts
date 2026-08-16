import { ipcMain } from 'electron'
import { setPiExecutableOverride } from '../pi-rpc-manager'
import { WorkspaceManager } from '../workspace-manager'
import { getGuiDataPath } from '../app-data-paths'
import type { AppSettings } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import { applyRunOnStartup } from '../startup-launch'
import { setTrayEnabled } from '../tray-manager'
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
      const saved = JSON.parse(data)
      return { ...DEFAULT_SETTINGS, ...saved }
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
    // Re-resolve the Pi binary so a corrected executable path takes effect on
    // the next start instead of requiring an app restart.
    if ('piExecutablePath' in settings) {
      setPiExecutableOverride((settings as Partial<AppSettings>).piExecutablePath)
    }
    return loadAppSettings(workspaceManager)
  })

  // Reconcile the OS-level "run on startup" state with the saved preference on
  // launch. Self-healing: repairs a stale Linux autostart Exec path after an
  // app update/move and re-asserts the login item on macOS/Windows. Runs in the
  // background so a failure never blocks handler registration.
  void loadAppSettings(workspaceManager)
    .then((settings) => applyRunOnStartup(settings.runOnStartup))
    .catch((err) => console.error('[startup] Failed to reconcile run-on-startup:', err))
}
