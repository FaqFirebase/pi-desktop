import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { DetectedRelay, PairedRelayAgent, RelayOpenResult, RemoteSessionRef } from '../../shared/ipc-contracts'
import { normalizeRelayUrl, parsePairingUri } from '../../shared/relay-protocol'
import type {
  RelayAskAnswer,
  RelayAskResponseEnrichment,
  RelayActionName,
  RelayExtensionUiResponseBody,
} from '../../shared/relay-protocol'
import { assertTrustedSender } from './validation'
import { appLog } from '../app-log'
import type { RelaySessionBridge } from '../relay/relay-bridge'
import { detectRelayUrl } from '../relay/relay-url-detection'

/**
 * Remote-pi relay channels.
 *
 * Every handler is a thin validation shell: pairing input is user-pasted text
 * and must never reach the socket unparsed, and no handler returns the private
 * key or the pairing token.
 */
export function registerRelayHandlers(bridge: RelaySessionBridge): void {
  ipcMain.handle(IPC_CHANNELS.RELAY_STATUS, async (event) => {
    assertTrustedSender(event)
    return bridge.getStatus()
  })

  // Detection is read-only and advisory: it reports what the Pi on this machine
  // already uses. It never writes, so opening Settings cannot reconfigure a
  // relay the user has not chosen here.
  ipcMain.handle(IPC_CHANNELS.RELAY_DETECT_URL, async (event): Promise<DetectedRelay | null> => {
    assertTrustedSender(event)
    try {
      return await detectRelayUrl()
    } catch (error) {
      logRelayFailure('detect the relay URL', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_SET_URL, async (event, input: unknown) => {
    assertTrustedSender(event)
    const raw = typeof input === 'string' ? input.trim() : ''
    if (!raw) return bridge.setUrl(null)
    const normalized = normalizeRelayUrl(raw)
    if (!normalized) {
      throw new Error('The relay URL must start with http:// or https://')
    }
    return bridge.setUrl(normalized)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_PAIR, async (event, input: unknown): Promise<PairedRelayAgent> => {
    assertTrustedSender(event)
    const uri = typeof input === 'string' ? input : ''
    const parsed = parsePairingUri(uri)
    if (!parsed) {
      throw new Error('That is not a pairing link. Run /remote-pi pair on the other machine and paste the whole code it prints.')
    }
    try {
      return await bridge.pair(parsed)
    } catch (error) {
      logRelayFailure('pair', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_UNPAIR, async (event) => {
    assertTrustedSender(event)
    return bridge.unpair()
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_LIST_ROOMS, async (event) => {
    assertTrustedSender(event)
    return bridge.listRooms()
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_SESSIONS, async (event) => {
    assertTrustedSender(event)
    try {
      return await bridge.sessions()
    } catch (error) {
      logRelayFailure('session listing', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_OPEN_SESSION, async (event, input: unknown): Promise<RelayOpenResult> => {
    assertTrustedSender(event)
    if (!isRemoteSessionRef(input)) throw new Error('A remote session reference is required')
    try {
      return await bridge.openSession(input)
    } catch (error) {
      logRelayFailure('session open', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_SELECT_ROOM, async (event, roomId: unknown) => {
    assertTrustedSender(event)
    if (typeof roomId !== 'string' || roomId.length === 0) {
      throw new Error('A session id is required')
    }
    return bridge.selectRoom(roomId)
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_SYNC_SESSION, async (event) => {
    assertTrustedSender(event)
    try {
      return await bridge.syncSession()
    } catch (error) {
      logRelayFailure('session sync', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_SEND_PROMPT, async (event, text: unknown, options: unknown) => {
    assertTrustedSender(event)
    if (typeof text !== 'string' || !text.trim()) throw new Error('A prompt cannot be empty')
    await bridge.sendPrompt(text, validatePromptOptions(options))
    return { ok: true as const }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_CANCEL, async (event) => {
    assertTrustedSender(event)
    await bridge.cancel()
    return { ok: true as const }
  })

  ipcMain.handle(
    IPC_CHANNELS.RELAY_RESPOND_EXTENSION_UI,
    async (event, requestId: unknown, response: unknown) => {
      assertTrustedSender(event)
      if (typeof requestId !== 'string' || !requestId.trim()) {
        throw new Error('An interactive response needs the request id it answers')
      }
      const validated = validateExtensionUiResponse(response)
      await bridge.respondExtensionUi(requestId.trim(), validated)
      return { ok: true as const }
    },
  )

  ipcMain.handle(IPC_CHANNELS.RELAY_ACTION, async (event, name: unknown, payload: unknown) => {
    assertTrustedSender(event)
    const action = validateActionName(name)
    await bridge.runAction(action, validateActionPayload(payload))
    return { ok: true as const }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_LIST_MODELS, async (event) => {
    assertTrustedSender(event)
    return bridge.listModels()
  })
}

/**
 * Narrows a prompt's optional images.
 *
 * Base64 image bytes are the one large payload this channel carries, so a
 * malformed entry is refused here rather than shipped to the other machine and
 * failing inside the Pi where the error is far from the user.
 */
function validatePromptOptions(raw: unknown): { images?: { data: string; mime: string }[] } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object') throw new Error('Prompt options must be an object')
  const input = raw as { images?: unknown }
  if (input.images === undefined) return {}
  if (!Array.isArray(input.images)) throw new Error('Prompt images must be a list')
  const images = input.images.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Prompt image ${index} must be an object`)
    const image = entry as { data?: unknown; mime?: unknown }
    if (typeof image.data !== 'string' || !image.data) throw new Error(`Prompt image ${index} has no data`)
    if (typeof image.mime !== 'string' || !image.mime) throw new Error(`Prompt image ${index} has no mime type`)
    return { data: image.data, mime: image.mime }
  })
  return images.length > 0 ? { images } : {}
}

/** Rejects an action name the Pi has no handler for, instead of timing out on it. */
function validateActionName(raw: unknown): RelayActionName {
  if (raw === 'session_new' || raw === 'session_compact' || raw === 'model_set' || raw === 'thinking_set') {
    return raw
  }
  throw new Error(`Unsupported remote action: ${String(raw)}`)
}

/**
 * Narrows an action payload.
 *
 * The Pi takes a structured payload rather than a string to parse, so an action
 * with missing fields would be accepted and then fail on the far side; rejecting
 * it here keeps the error next to the caller.
 */
function validateActionPayload(raw: unknown): { provider?: string; modelId?: string; level?: string } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object') throw new Error('An action payload must be an object')
  const input = raw as Record<string, unknown>
  const payload: { provider?: string; modelId?: string; level?: string } = {}
  if (typeof input.provider === 'string') payload.provider = input.provider
  if (typeof input.modelId === 'string') payload.modelId = input.modelId
  if (typeof input.level === 'string') payload.level = input.level
  return payload
}

/**
 * Validates an interactive response that arrived over IPC.
 *
 * The renderer builds this itself, but it is the one payload that answers a
 * blocking prompt on the other machine, so a malformed shape must be rejected
 * here rather than sent: the Pi routes on the discriminator and a frame with the
 * wrong one is silently dropped, which would leave the turn waiting out its
 * full TTL.
 */
function validateExtensionUiResponse(raw: unknown): RelayExtensionUiResponseBody {
  if (!raw || typeof raw !== 'object') throw new Error('An interactive response must be an object')
  const input = raw as Record<string, unknown>

  if (input.ask !== undefined) {
    return { ask: validateAskResponse(input.ask) }
  }
  if (input.cancelled === true) return { cancelled: true }
  if (typeof input.confirmed === 'boolean') return { confirmed: input.confirmed }
  if (typeof input.value === 'string') return { value: input.value }
  throw new Error('An interactive response needs a value, a confirmed flag, a cancel, or an ask envelope')
}

/** Narrows the rich pi-ask answer, which the Pi forwards to pi-ask verbatim. */
function validateAskResponse(raw: unknown): RelayAskResponseEnrichment {
  if (!raw || typeof raw !== 'object') throw new Error('An ask response must be an object')
  const input = raw as Record<string, unknown>
  const flowId = typeof input.flow_id === 'string' ? input.flow_id.trim() : ''
  if (!flowId) throw new Error('An ask response needs the flow_id it answers')

  if (input.kind === 'cancel') return { flow_id: flowId, kind: 'cancel' }
  if (input.kind !== 'answer') throw new Error('An ask response must be an answer or a cancel')

  const answers = input.answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('An ask answer needs an answers object')
  }
  const validated: Record<string, RelayAskAnswer> = {}
  for (const [questionId, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const answer: RelayAskAnswer = {}
    if (Array.isArray(entry.values)) answer.values = entry.values.map(String)
    if (typeof entry.customText === 'string') answer.customText = entry.customText
    if (typeof entry.note === 'string') answer.note = entry.note
    if (entry.optionNotes && typeof entry.optionNotes === 'object') {
      answer.optionNotes = Object.fromEntries(
        Object.entries(entry.optionNotes as Record<string, unknown>).map(([key, text]) => [key, String(text)]),
      )
    }
    validated[questionId] = answer
  }
  const mode = input.mode === 'elaborate' ? 'elaborate' : input.mode === 'submit' ? 'submit' : undefined
  return mode ? { flow_id: flowId, kind: 'answer', mode, answers: validated } : { flow_id: flowId, kind: 'answer', answers: validated }
}

/** Reports a relay failure without leaking pairing material into the log. */export function logRelayFailure(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  appLog.warn('relay', `Relay action failed: ${action}`, message)
}

/**
 * Validates a `RemoteSessionRef` that arrived over IPC.
 *
 * The renderer supplies this, so it is untrusted input even though the UI builds
 * it itself: a malformed ref would otherwise reach the socket as an addressing
 * attempt on a room that does not belong to the paired peer.
 */
function isRemoteSessionRef(value: unknown): value is RemoteSessionRef {
  if (typeof value !== 'object' || value === null) return false
  const ref = value as Partial<RemoteSessionRef>
  return (
    typeof ref.peer === 'string' &&
    ref.peer.length > 0 &&
    typeof ref.roomId === 'string' &&
    ref.roomId.length > 0 &&
    (ref.hostname === undefined || typeof ref.hostname === 'string')
  )
}
