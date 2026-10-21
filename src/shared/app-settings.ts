import type { AgentEngine, AppSettings, PairedRelayAgent, RelaySettings } from './ipc-contracts'
import { DEFAULT_SETTINGS } from './default-settings'
import { normalizeLanguageSetting } from './i18n/resolve'
import { normalizeRelayUrl } from './relay-protocol'
import { isPermissionMode } from './permission-mode'
import { getVoiceModel, type VoicePrecision } from './voice-models'
import { isVoiceDevice } from './voice-device'
import { isChatWidth } from './chat-width'
import { normalizeKeyboardShortcuts } from './keyboard-shortcuts'

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
  merged.uiFontFamily = typeof merged.uiFontFamily === 'string'
    ? merged.uiFontFamily.trim()
    : DEFAULT_SETTINGS.uiFontFamily
  if (typeof merged.defaultThinkingLevel !== 'string' || !merged.defaultThinkingLevel.trim()) {
    merged.defaultThinkingLevel = DEFAULT_SETTINGS.defaultThinkingLevel
  }
  merged.language = normalizeLanguageSetting(merged.language, languages)
  merged.shortcuts = normalizeKeyboardShortcuts(merged.shortcuts)
  if (typeof merged.voiceModel !== 'string' || !getVoiceModel(merged.voiceModel)) {
    merged.voiceModel = DEFAULT_SETTINGS.voiceModel
  }
  if (!isVoicePrecision(merged.voicePrecision)) merged.voicePrecision = DEFAULT_SETTINGS.voicePrecision
  if (!isVoiceDevice(merged.voiceDevice)) merged.voiceDevice = DEFAULT_SETTINGS.voiceDevice
  merged.relay = normalizeRelaySettings(merged.relay)
  return merged
}

const RELAY_PUBKEY_BYTES = 32

/**
 * Keeps a hand-edited `relay` block usable without trusting it.
 *
 * A relay url that the client cannot dial is dropped to null rather than kept,
 * because a stored-but-invalid url would retry forever against a dead endpoint.
 */
function normalizeRelaySettings(value: unknown): RelaySettings {
  if (!value || typeof value !== 'object') return DEFAULT_SETTINGS.relay
  const candidate = value as Partial<RelaySettings>
  const url = typeof candidate.url === 'string' && normalizeRelayUrl(candidate.url) ? candidate.url : null
  return {
    // Without a usable url nothing can be dialled, so enabled cannot outlive it.
    enabled: url !== null && candidate.enabled === true,
    url,
    pairedAgent: normalizePairedAgent(candidate.pairedAgent),
  }
}

function normalizePairedAgent(value: unknown): PairedRelayAgent | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PairedRelayAgent>
  if (typeof candidate.pubkey !== 'string' || typeof candidate.pairedAt !== 'string') return null
  if (Buffer.from(candidate.pubkey, 'base64').length !== RELAY_PUBKEY_BYTES) return null
  return {
    pubkey: candidate.pubkey,
    agentName: typeof candidate.agentName === 'string' ? candidate.agentName : '',
    pairedAt: candidate.pairedAt,
  }
}
