import type { AgentEngine, AppSettings } from './ipc-contracts'
import { DEFAULT_SETTINGS } from './default-settings'
import { normalizeLanguageSetting } from './i18n/resolve'
import { isPermissionMode } from './permission-mode'
import { getVoiceModel, type VoicePrecision } from './voice-models'
import { isVoiceDevice } from './voice-device'
import { isChatWidth } from './chat-width'

const ENGINE_SETTINGS: readonly AgentEngine[] = ['auto', 'pi', 'omp']
const VOICE_PRECISIONS: readonly VoicePrecision[] = ['int8', 'fp16']

function isEngineSetting(value: unknown): value is AgentEngine {
  return typeof value === 'string' && (ENGINE_SETTINGS as readonly string[]).includes(value)
}

function isVoicePrecision(value: unknown): value is VoicePrecision {
  return typeof value === 'string' && (VOICE_PRECISIONS as readonly string[]).includes(value)
}

/**
 * Merge a settings file over the defaults and replace every enumerated value
 * the file may hold in a form no build writes (hand edits, other versions), so
 * the renderer never indexes a lookup with an unknown key.
 */
export function normalizeStoredSettings(stored: Record<string, unknown>, languages: readonly string[]): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...stored }
  if (!isEngineSetting(merged.piEngine)) merged.piEngine = DEFAULT_SETTINGS.piEngine
  if (!isPermissionMode(merged.permissionMode)) merged.permissionMode = DEFAULT_SETTINGS.permissionMode
  if (!isChatWidth(merged.chatWidth)) merged.chatWidth = DEFAULT_SETTINGS.chatWidth
  merged.language = normalizeLanguageSetting(merged.language, languages)
  if (typeof merged.voiceModel !== 'string' || !getVoiceModel(merged.voiceModel)) {
    merged.voiceModel = DEFAULT_SETTINGS.voiceModel
  }
  if (!isVoicePrecision(merged.voicePrecision)) merged.voicePrecision = DEFAULT_SETTINGS.voicePrecision
  if (!isVoiceDevice(merged.voiceDevice)) merged.voiceDevice = DEFAULT_SETTINGS.voiceDevice
  return merged
}
