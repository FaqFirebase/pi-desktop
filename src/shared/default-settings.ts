import type { AppSettings } from './ipc-contracts'
import { DEFAULT_COUNCIL_CONFIG } from './council-config'
import { DEFAULT_SIDEBAR_WIDTH } from './sidebar-width'
import { DEFAULT_CHAT_WIDTH } from './chat-width'
import { SYSTEM_LANGUAGE } from './i18n/languages'

export const GIT_CONVEYOR_NOTICE_TIMEOUT_MS = {
  success: 5_000,
  error: 10_000,
} as const

/**
 * The single source of truth for default app settings. Used by the main process
 * to seed settings.json on first run, and by the renderer's Settings panel for
 * its "Reset to defaults" action and initial field values. Change a default here
 * and it applies everywhere.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  piExecutablePath: 'pi',
  piEngine: 'auto',
  defaultArgs: [],
  theme: 'system',
  systemLightTheme: 'light',
  systemDarkTheme: 'dark',
  defaultModel: null,
  defaultProvider: null,
  defaultCwd: null,
  fontSize: 16,
  uiFontFamily: '',
  terminalFontSize: 12,
  codeEditorFontSize: 14,
  chatWidth: DEFAULT_CHAT_WIDTH,
  showThinking: true,
  autoScroll: true,
  permissionMode: 'ask-edits',
  permissionRulesAckWorkspaces: [],
  resumeLastSession: true,
  collapsedSessionGroups: [],
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  openToHomeOnLaunch: true,
  runOnStartup: false,
  minimizeToTrayOnClose: false,
  hasSeenTrayHint: false,
  desktopNotifications: true,
  language: SYSTEM_LANGUAGE,
  council: DEFAULT_COUNCIL_CONFIG,
  voiceModel: null,
  voicePrecision: 'int8',
  voiceDevice: 'auto',
}
