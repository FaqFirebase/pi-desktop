import { t } from '../shared/i18n'
import { getGuiDataPath } from './app-data-paths'
import { ApiKeyStore } from './api-key-store'
import { encodeWav, TARGET_SAMPLE_RATE } from '../shared/voice-audio'
import { voiceServerEndpoint, type VoiceServerSettings } from '../shared/voice-server'

// One segment is at most a minute of speech; a server that has not answered
// in that time is treated as down rather than left holding the dictation.
export const VOICE_SERVER_TIMEOUT_MS = 60_000
const MS_PER_SECOND = 1000
// Enough of an error body to show the server's reason without a page of HTML.
const ERROR_DETAIL_MAX_CHARS = 200
const WAV_FILE_NAME = 'speech.wav'
const WAV_MIME_TYPE = 'audio/wav'
const WHITESPACE_RUN = /\s+/g

const VOICE_SERVER_KEY_FILE = 'voice-server-api-key'

/** The speech server's API key, if it needs one. Read again for each request, so another program can set it. */
export const voiceServerKeyStore = new ApiKeyStore(() => getGuiDataPath(VOICE_SERVER_KEY_FILE))

export interface VoiceServerRequest {
  server: VoiceServerSettings
  /** Sent as a Bearer token only when there is one. */
  apiKey: string | null
  /** Mono 16 kHz samples in [-1, 1]. */
  audio: Float32Array
}

/** The multipart body of an OpenAI-compatible `audio/transcriptions` request. Empty optional fields are left out. */
export function transcriptionForm(server: VoiceServerSettings, audio: Float32Array): FormData {
  const form = new FormData()
  form.append('file', new Blob([encodeWav(audio, TARGET_SAMPLE_RATE)], { type: WAV_MIME_TYPE }), WAV_FILE_NAME)
  form.append('model', server.model)
  if (server.language) form.append('language', server.language)
  if (server.prompt) form.append('prompt', server.prompt)
  form.append('response_format', 'json')
  return form
}

/** The body as JSON, or undefined when it is not JSON (an HTML error page, plain text). */
function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/** The server's own reason for a failed request: `error.message` of an OpenAI-style body, else the body text. */
function errorDetail(body: string, statusText: string): string {
  const error = (parseJsonBody(body) as { error?: unknown } | undefined)?.error
  const message = typeof error === 'string' ? error : (error as { message?: unknown } | undefined)?.message
  const detail = typeof message === 'string' && message.trim() ? message : body
  return (detail.replace(WHITESPACE_RUN, ' ').trim() || statusText).slice(0, ERROR_DETAIL_MAX_CHARS)
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
}

/**
 * Send one segment to the user's transcription server and return its text.
 * Each failure throws a message the composer shows as is: no address or
 * model, the server cannot be reached, it took longer than
 * VOICE_SERVER_TIMEOUT_MS, it answered with an error status, or its answer
 * has no text.
 */
export async function transcribeWithServer(
  { server, apiKey, audio }: VoiceServerRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const endpoint = voiceServerEndpoint(server.baseUrl)
  if (!endpoint || !server.model) throw new Error(t('errors.voice.serverNotConfigured'))
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: transcriptionForm(server, audio),
      signal: AbortSignal.timeout(VOICE_SERVER_TIMEOUT_MS),
    })
    const body = await response.text()
    if (!response.ok) {
      const detail = errorDetail(body, response.statusText)
      throw new Error(t('errors.voice.serverStatus', { status: response.status, detail }))
    }
    const text = (parseJsonBody(body) as { text?: unknown } | undefined)?.text
    if (typeof text !== 'string') throw new Error(t('errors.voice.serverBadResponse'))
    return text.trim()
  } catch (err) {
    if (isTimeout(err)) {
      const seconds = VOICE_SERVER_TIMEOUT_MS / MS_PER_SECOND
      throw new Error(t('errors.voice.serverTimeout', { url: endpoint, seconds }), { cause: err })
    }
    // fetch rejects with a TypeError when the server cannot be reached (refused, DNS, TLS).
    if (err instanceof TypeError) {
      const reason = err.cause instanceof Error ? err.cause.message : err.message
      throw new Error(t('errors.voice.serverUnreachable', { url: endpoint, reason }), { cause: err })
    }
    throw err
  }
}
