import type { AppSettings } from './ipc-contracts'
import { DEFAULT_COUNCIL_CONFIG } from './council-config'

/**
 * The single source of truth for default app settings. Used by the main process
 * to seed settings.json on first run, and by the renderer's Settings panel for
 * its "Reset to defaults" action and initial field values. Change a default here
 * and it applies everywhere.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  piExecutablePath: 'pi',
  defaultArgs: [],
  theme: 'breeze-dark',
  defaultModel: null,
  defaultProvider: null,
  defaultCwd: null,
  fontSize: 16,
  terminalFontSize: 12,
  codeEditorFontSize: 14,
  showThinking: false,
  autoScroll: true,
  permissionMode: 'ask-edits',
  resumeLastSession: true,
  collapsedSessionGroups: [],
  openToHomeOnLaunch: true,
  council: DEFAULT_COUNCIL_CONFIG,
}
