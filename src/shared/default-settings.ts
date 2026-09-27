import type { AppSettings } from './ipc-contracts'
import { DEFAULT_COUNCIL_CONFIG } from './council-config'
import { DEFAULT_SIDEBAR_WIDTH } from './sidebar-width'
import { DEFAULT_CHAT_WIDTH } from './chat-width'
import { SYSTEM_LANGUAGE } from './i18n/languages'
import { DEFAULT_KEYBOARD_SHORTCUTS } from './keyboard-shortcuts'

export const GIT_COMMIT_MESSAGE_CONFIG = {
  maxMessageLength: 10_000,
  maxSuggestionLength: 120,
  maxDiffBytes: 120_000,
  maxOutputBytes: 1_000_000,
  timeoutMs: 60_000,
} as const

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
  theme: 'dark',
  systemLightTheme: 'light',
  systemDarkTheme: 'dark',
  defaultModel: null,
  defaultProvider: null,
  defaultThinkingLevel: null,
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
  shortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
  council: DEFAULT_COUNCIL_CONFIG,
  voiceModel: null,
  voicePrecision: 'int8',
  voiceDevice: 'auto',
}
