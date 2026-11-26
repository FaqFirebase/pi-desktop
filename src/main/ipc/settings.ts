import { ipcMain } from 'electron'
import { homedir } from 'os'
import { setPiExecutableOverride } from '../pi-rpc-manager'
import { WorkspaceManager } from '../workspace-manager'
import { getGuiDataPath } from '../app-data-paths'
import type { AppSettings } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { QUICK_CHAT_CHANNELS } from '../../shared/quick-chat'
import { getQuickChatWindow, openQuickChatWindow } from '../quick-chat-window'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import { shortcutAccelerator, shortcutProblem } from '../../shared/keyboard-shortcuts'
import { availableLanguages } from '../../shared/i18n'
import { normalizeStoredSettings } from '../../shared/app-settings'
import { applyLanguageSetting, getI18nEnvironment, isPseudoLanguageEnabled } from '../i18n'
import { applyRunOnStartup, runOnStartupAvailable } from '../startup-launch'
import { setOmpLaunchArgs } from '../omp-paths'
import { setTrayEnabled } from '../tray-manager'
import { applyKeepAwakeMode } from '../keep-awake-service'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { isObject } from './validation'
import { appLog } from '../app-log'
import { writeJsonFileAtomic } from '../atomic-file-write'
import { createSerialQueue } from '../serial-queue'
import { t } from '../../shared/i18n'
import type { IpcContext } from './context'

// ─── App Settings Persistence ────────────────────────────────────────────────

const SETTINGS_FILE_NAME = 'settings.json'

/** Also consumed by the diagnostics report. */
export function getSettingsPath(): string {
  return getGuiDataPath(SETTINGS_FILE_NAME)
}

// Every save reads, merges and writes settings.json; running them one at a
// time makes each save merge onto the file the previous save wrote.
const runSettingsFileTask = createSerialQueue()

/** Told when settings.json exists but cannot be read; see onUnreadableSettings. */
export type UnreadableSettingsListener = (settingsPath: string) => void

let unreadableSettingsListener: UnreadableSettingsListener | null = null
/** Files the listener has been told about, so a user learns of each once per run. */
const reportedUnreadableSettings = new Set<string>()

/**
 * Register the one listener that tells the user their settings file cannot
 * be read. Every load then falls back to the defaults and every save is
 * refused, and several callers ignore a refused save, so without this the
 * user would see settings that do not stick and no reason why.
 */
export function onUnreadableSettings(listener: UnreadableSettingsListener): void {
  unreadableSettingsListener = listener
}

function reportUnreadableSettings(settingsPath: string, err: unknown): void {
  if (reportedUnreadableSettings.has(settingsPath)) return
  reportedUnreadableSettings.add(settingsPath)
  appLog.error('settings', `Cannot read ${settingsPath}; using the default settings`, err)
  unreadableSettingsListener?.(settingsPath)
}

/**
 * The stored settings object, or null when there is no settings file. A file
 * that exists but does not hold a settings object throws, and the user is
 * told once.
 */
async function readStoredSettings(settingsPath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(settingsPath)) return null
  try {
    const stored: unknown = JSON.parse(await readFile(settingsPath, 'utf-8'))
    if (!isObject(stored)) throw new TypeError('settings.json does not hold an object')
    return stored
  } catch (err) {
    reportUnreadableSettings(settingsPath, err)
    throw new Error(t('errors.settings.unreadable', { path: settingsPath }), { cause: err })
  }
}

export async function loadAppSettings(workspaceManager: WorkspaceManager): Promise<AppSettings> {
  // Wait for the saves queued before this load, so a caller reads its own save.
  await runSettingsFileTask(async () => undefined)
  try {
    const stored = await readStoredSettings(getSettingsPath())
    if (stored) return normalizeStoredSettings(stored, availableLanguages(isPseudoLanguageEnabled()))
  } catch {
    // Fall through to defaults; readStoredSettings has told the user.
  }

  return {
    ...DEFAULT_SETTINGS,
    defaultCwd: workspaceManager.getActiveWorkspace()?.path ?? homedir(),
  }
}

async function mergeIntoSettingsFile(settings: Partial<AppSettings>): Promise<void> {
  if ('shortcuts' in settings) {
    if (!settings.shortcuts || typeof settings.shortcuts !== 'object' || Array.isArray(settings.shortcuts)) {
      throw new Error('Invalid keyboard shortcuts')
    }
    const problem = shortcutProblem(settings.shortcuts, process.platform)
    if (problem) throw new Error(`Invalid keyboard shortcut: ${problem.action} (${problem.kind})`)
  }
  const settingsPath = getSettingsPath()
  try {
    // A file that exists but cannot be read is refused: writing over it would
    // replace every setting the user has with the defaults.
    const existing = await readStoredSettings(settingsPath)
    await writeJsonFileAtomic(settingsPath, { ...DEFAULT_SETTINGS, ...existing, ...settings })
  } catch (err) {
    // Still propagate to the caller (the Settings panel surfaces it); the log
    // keeps a trace for diagnostics in packaged builds.
    appLog.error('settings', 'Failed to save settings.json', err)
    throw err
  }
}

export function saveAppSettings(settings: Partial<AppSettings>): Promise<void> {
  return runSettingsFileTask(() => mergeIntoSettingsFile(settings))
}

/**
 * Apply the "default args" setting to the OMP profile the app reads (see
 * omp-paths.ts). A name OMP would refuse makes OMP itself fail to start; say why.
 */
export function applyOmpLaunchArgs(args: readonly string[]): void {
  const { invalid } = setOmpLaunchArgs(args)
  if (invalid !== undefined) {
    appLog.warn('app', `OMP profile "${invalid}" is not a valid OMP profile name; showing the default profile's files`)
  }
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  const { workspaceManager, globalDictationShortcut, quickChatShortcut } = ctx

  // ─── Settings ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, async (event) => {
    ctx.assertMainSender(event)
    return loadAppSettings(workspaceManager)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SAVE, async (_event, settings: unknown) => {
    ctx.assertMainSender(_event)
    // Do not let a late startup read replace a binding just saved by the user.
    await startupSettingsApplied
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
    // Re-resolve the Pi binary so a corrected executable path or explicit engine
    // takes effect on the next runtime start without relying on filename sniffing.
    const updated = await loadAppSettings(workspaceManager)
    // Take or release the sleep block at once, with the normalized mode.
    // Awaited so the status the Settings panel reads next is the new one.
    if ('keepAwakeMode' in settings) await applyKeepAwakeMode(updated.keepAwakeMode)
    if ('piExecutablePath' in settings || 'piEngine' in settings) {
      setPiExecutableOverride(updated.piExecutablePath, updated.piEngine)
    }
    if ('defaultArgs' in settings) {
      applyOmpLaunchArgs(updated.defaultArgs)
    }
    if ('language' in settings) {
      applyLanguageSetting(updated.language)
    }
    if ('shortcuts' in settings) {
      // A swap between the two actions must not fail because the new key is
      // still held by the other action: free each desired key first, then
      // register. Unchanged registrations are left untouched.
      const dictation = updated.shortcuts.globalDictation ? shortcutAccelerator(updated.shortcuts.globalDictation) : null
      const quickChat = updated.shortcuts.quickChat ? shortcutAccelerator(updated.shortcuts.quickChat) : null
      if (dictation) quickChatShortcut.releaseKey(dictation)
      if (quickChat) globalDictationShortcut.releaseKey(quickChat)
      globalDictationShortcut.apply(updated.shortcuts.globalDictation)
      quickChatShortcut.apply(updated.shortcuts.quickChat)
    }
    const quickChatWindow = getQuickChatWindow()
    if (quickChatWindow && !quickChatWindow.isDestroyed()) {
      quickChatWindow.webContents.send(QUICK_CHAT_CHANNELS.update, { type: 'settings', settings: updated })
    }
    return updated
  })

  ipcMain.handle(IPC_CHANNELS.I18N_GET_ENVIRONMENT, () => getI18nEnvironment())

  ipcMain.handle(IPC_CHANNELS.SETTINGS_RUN_ON_STARTUP_AVAILABLE, (event) => {
    ctx.assertMainSender(event)
    return runOnStartupAvailable()
  })

  ipcMain.handle(IPC_CHANNELS.QUICK_CHAT_SHORTCUT_STATUS, async (event) => {
    ctx.assertMainSender(event)
    await startupSettingsApplied
    return quickChatShortcut.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_OPEN_QUICK_CHAT, async (event) => {
    ctx.assertMainSender(event)
    openQuickChatWindow()
  })

  // Reconcile the OS-level "run on startup" state with the saved preference on
  // launch. Self-healing: repairs a stale Linux autostart Exec path after an
  // app update/move and re-asserts the login item on macOS/Windows. Runs in the
  // background so a failure never blocks handler registration. The saved
  // system-wide shortcuts are bound here too.
  const startupSettingsApplied = loadAppSettings(workspaceManager)
    .then((settings) => {
      globalDictationShortcut.apply(settings.shortcuts.globalDictation)
      quickChatShortcut.apply(settings.shortcuts.quickChat)
      return applyRunOnStartup(settings.runOnStartup)
    })
    .catch((err) => console.error('[startup] Failed to apply startup settings:', err))
}
