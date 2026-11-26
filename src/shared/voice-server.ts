import type { VoiceStatus } from './ipc-contracts'

// Voice dictation can send its speech to a server instead of the model on this
// computer. The server speaks the OpenAI-compatible transcription API: each
// segment is POSTed as a WAV file to `{baseUrl}/audio/transcriptions` and the
// answer is `{ "text": "..." }`. No server is named or preset: the user enters
// the address, and the main process makes the call (the renderer's CSP has no
// network).

/** Where dictation turns speech into text: this computer, or the user's server. */
export type VoiceTranscriber = 'local' | 'server'

export const VOICE_TRANSCRIBERS: readonly VoiceTranscriber[] = ['local', 'server']

export function isVoiceTranscriber(value: unknown): value is VoiceTranscriber {
  return typeof value === 'string' && (VOICE_TRANSCRIBERS as readonly string[]).includes(value)
}

/** The server the user chose. Empty `language` lets the server detect it; empty `prompt` sends none. */
export interface VoiceServerSettings {
  baseUrl: string
  model: string
  language: string
  prompt: string
}

export const DEFAULT_VOICE_SERVER: VoiceServerSettings = { baseUrl: '', model: '', language: '', prompt: '' }

const VOICE_SERVER_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])
const TRANSCRIPTIONS_PATH = 'audio/transcriptions'
const TRAILING_SLASHES = /\/+$/

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Every field a trimmed string, whatever a settings file holds. */
export function normalizeVoiceServerSettings(value: unknown): VoiceServerSettings {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    baseUrl: trimmedString(stored.baseUrl),
    model: trimmedString(stored.model),
    language: trimmedString(stored.language),
    prompt: trimmedString(stored.prompt),
  }
}

/**
 * The transcription endpoint under `baseUrl`, or null when it is not an http
 * or https address. Credentials, a query or a fragment are refused: the key
 * has its own field, and the path is appended to the base.
 */
export function voiceServerEndpoint(baseUrl: string): string | null {
  const parsed = URL.parse(baseUrl)
  if (!parsed || !VOICE_SERVER_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return null
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
  return `${parsed.origin}${parsed.pathname.replace(TRAILING_SLASHES, '')}/${TRANSCRIPTIONS_PATH}`
}

/** A server is usable once it has a valid address and a model. */
export function voiceServerReady(server: VoiceServerSettings): boolean {
  return voiceServerEndpoint(server.baseUrl) !== null && server.model !== ''
}

/** Dictation can start: the chosen server is set up, or the selected local model is installed. */
export function voiceDictationReady(status: VoiceStatus): boolean {
  if (status.transcriber === 'server') return voiceServerReady(status.server)
  const selected = (model: { id: string }) => model.id === status.selectedModel
  return status.catalog.some(selected) && status.installed.some(selected)
}
