/**
 * Wire protocol for the remote-pi relay, shared by main and its tests.
 *
 * The relay routes opaque `ct` blobs; the inner JSON is read by the paired Pi,
 * so these shapes mirror remote-pi's `protocol/types.ts`.
 */

/** Channels the relay understands outside the opaque envelope. */
export interface RelayOuterEnvelope {
  /** Destination (outbound) or sender (inbound) peer id: an Ed25519 pubkey. */
  peer: string
  /** Target room. On outbound frames an empty value means "derive from `peer`". */
  room: string
  /** base64 of the inner JSON. The relay never parses this. */
  ct: string
}

export interface RelayHello {
  type: 'hello'
  pubkey: string
  room_id?: string
}

export interface RelayChallenge {
  type: 'challenge'
  nonce: string
}

export interface RelayAuth {
  type: 'auth'
  sig: string
}

export type RelayControlFrame =
  | { type: 'challenge'; nonce: string }
  | { type: 'error'; code?: string; message?: string }
  | { type: 'presence'; states: unknown[] }
  | { type: 'rooms'; peer: string; rooms: RelayRoomInfo[] }

/** One live Pi session as advertised by the relay's `rooms` frame. */
export interface RelayRoomInfo {
  cwd: string
  name: string
  room_id: string
  model?: string
  thinking?: string
  working?: boolean
  started_at?: number
}

/** One option in a pi-ask question. `freeform` allows a typed answer. */
export interface RelayAskOption {
  value: string
  label: string
  description?: string
  preview?: string
  freeform?: boolean
}

/** One question inside a pi-ask flow. */
export interface RelayAskQuestion {
  id: string
  label: string
  prompt: string
  type: 'single' | 'multi' | 'preview'
  required: boolean
  presentedType?: 'single' | 'multi' | 'preview'
  requestedType?: 'single' | 'multi' | 'preview'
  options: RelayAskOption[]
}

/**
 * pi-ask enrichment on an `extension_ui_request`.
 *
 * One flow carries every question it will ask, and is answered in a single
 * submit. Keys inside `answers` mirror pi-ask's own camelCase schema verbatim
 * (unlike the snake_case frame-level fields) so the Pi can forward a response
 * without a remap pass.
 */
export interface RelayAskEnrichment {
  flow_id: string
  tool_call_id: string | null
  source: string
  title: string | null
  questions: RelayAskQuestion[]
}

/** One question's answered parts, as pi-ask records them. */
export interface RelayAskAnswer {
  values?: string[]
  customText?: string
  note?: string
  optionNotes?: Record<string, string>
}

/** The structured answer that supersedes value/confirmed/cancelled. */
export type RelayAskResponseEnrichment =
  | { flow_id: string; kind: 'answer'; mode?: 'submit' | 'elaborate'; answers: Record<string, RelayAskAnswer> }
  | { flow_id: string; kind: 'cancel' }

/** Interactive extension prompt pushed by the Pi (mirrors the SDK's RPC contract). */
export type RelayExtensionUiRequest =
  | { type: 'extension_ui_request'; id: string; method: 'select'; title: string; options: string[]; ask?: RelayAskEnrichment }
  | { type: 'extension_ui_request'; id: string; method: 'confirm'; title: string; message: string; ask?: RelayAskEnrichment }
  | { type: 'extension_ui_request'; id: string; method: 'input'; title: string; placeholder?: string; ask?: RelayAskEnrichment }
  | { type: 'extension_ui_request'; id: string; method: 'editor'; title: string; prefill?: string; ask?: RelayAskEnrichment }
  | { type: 'extension_ui_request'; id: string; method: 'notify'; message: string; notify_type?: 'info' | 'warning' | 'error' }

/**
 * Answer to an `extension_ui_request`.
 *
 * A client that rendered the rich pi-ask flow submits ONLY `ask` (the structured
 * answers supersede the discriminator); a client that rendered the degraded SDK
 * prompt sends `value`/`confirmed`/`cancelled` and the Pi maps the label back to
 * an option value.
 */
export type RelayExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string; ask?: RelayAskResponseEnrichment }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean; ask?: RelayAskResponseEnrichment }
  | { type: 'extension_ui_response'; id: string; cancelled: true; ask?: RelayAskResponseEnrichment }
  | { type: 'extension_ui_response'; id: string; ask: RelayAskResponseEnrichment }

/**
 * `Omit` that distributes over a union.
 *
 * Plain `Omit<Union, K>` collapses to the keys COMMON to every member, which
 * would erase the discriminators that make each response meaningful.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** The parts of a response a client supplies; the transport adds type and id. */
export type RelayExtensionUiResponseBody = DistributiveOmit<RelayExtensionUiResponse, 'type' | 'id'>

/**
 * One inline image attachment on a `user_message`.
 *
 * `data` is base64 (compressed app-side) and `mime` its content type; the Pi maps
 * this to the SDK's image content before handing it to the model.
 */
export interface WireImage {
  data: string
  mime: string
}

/**
 * How a prompt sent mid-turn is handled.
 *
 * The only value the Pi accepts is `steer`: the message is injected into the turn
 * already running instead of queueing behind it. Omitting it queues.
 */
export type StreamingBehavior = 'steer'

/** The typed actions a client can run on the paired Pi. */
export type RelayActionName = 'session_new' | 'session_compact' | 'model_set' | 'thinking_set'

/** One model row in a `models_list` reply. */
export interface WireModel {
  id: string
  name: string
  provider: string
  reasoning?: boolean
  context_window?: number
}

/** Requests the desktop sends to a paired Pi. */
export type RelayClientMessage =
  | { type: 'pair_request'; id: string; token: string; device_name: string }
  | { type: 'session_sync'; id: string }
  | { type: 'user_message'; id: string; text: string; images?: WireImage[]; streaming_behavior?: StreamingBehavior }
  | { type: 'cancel'; id: string; target_id: string }
  | { type: 'ping'; id: string }
  | { type: 'session_new'; id: string }
  | { type: 'session_compact'; id: string }
  | { type: 'model_set'; id: string; provider: string; model_id: string }
  | { type: 'thinking_set'; id: string; level: string }
  | { type: 'list_models'; id: string }
  | { type: 'queued_message_set'; id: string; text: string }
  | { type: 'queued_message_clear'; id: string; target_id?: string }
  | RelayExtensionUiResponse

/** Frames the Pi pushes to an attached peer. */
export type RelayServerMessage =
  | { type: 'pair_ok'; in_reply_to?: string; session_name?: string; room_id?: string; hostname?: string; harness?: unknown; session_started_at?: number }
  | { type: 'pair_error'; in_reply_to?: string; code: string; message?: string }
  | { type: 'session_history'; in_reply_to?: string; events: RelaySessionEvent[]; eos?: boolean; truncated?: boolean }
  | { type: 'user_input'; id?: string; text: string }
  // Echo of a `user_message` this peer sent. The Pi broadcasts it to every attached
  // owner so each client renders the same timeline; this desktop draws the bubble
  // optimistically on send, so the echo is deliberately not drawn again.
  | { type: 'user_message'; id?: string; text: string; images?: WireImage[]; streaming_behavior?: StreamingBehavior }
  | { type: 'agent_chunk'; in_reply_to?: string; delta: string }
  | { type: 'agent_done'; in_reply_to?: string }
  | { type: 'agent_message'; in_reply_to?: string; text: string }
  // Pushed after a context compaction, live and replayed on history re-sync.
  | { type: 'compaction'; summary?: string; tokens_before?: number; ts?: number }
  | { type: 'tool_request'; tool_call_id?: string; tool: string; args?: unknown }
  | { type: 'tool_result'; tool_call_id?: string; tool?: string; result?: unknown; is_error?: boolean }
  | { type: 'queued_message_state'; pending?: unknown[] }
  | { type: 'steer_consumed'; id?: string }
  | { type: 'error'; code: string; message?: string }
  | { type: 'cancelled'; in_reply_to?: string; target_id?: string }
  | { type: 'pong'; id?: string }
  // Sent when the Pi tears the pairing channel down; a reconnect is required.
  | { type: 'bye'; reason?: string }
  | { type: 'action_ok'; in_reply_to?: string; action?: string }
  | { type: 'action_error'; in_reply_to?: string; action?: string; error?: string }
  | { type: 'models_list'; in_reply_to?: string; models?: unknown[]; current?: unknown }
  | RelayExtensionUiRequest

/**
 * A relay-level roster push, not a Pi frame.
 *
 * It arrives on the same socket as Pi frames, so a decoder that assumes every
 * frame is a `RelayServerMessage` will silently drop or misread it.
 */
export interface RelayRoomsFrame {
  type: 'rooms'
  peer: string
  rooms: RelayRoomInfo[]
}

/** Everything the desktop may see on the control socket after auth. */
export type RelayInboundMessage = RelayServerMessage | RelayRoomsFrame | RelayRoomLifecycleFrame

/**
 * A single-session roster push, sent instead of a fresh `rooms` frame.
 *
 * The relay treats a session appearing (or ending) as an event, not as a new
 * full roster: subscribers get one frame per session. A client that only knows
 * how to read `rooms` therefore goes stale the moment a session starts or stops,
 * which is the common case — the Pi opens a session when the user prompts it.
 */
export type RelayRoomLifecycleFrame =
  | ({ type: 'room_announced'; peer: string } & RelayRoomInfo)
  | { type: 'room_ended'; peer: string; room_id: string; since_ts?: number }
  | { type: 'room_meta_updated'; peer: string; room_id: string; meta: Partial<RelayRoomInfo> }

/**
 * Relay-level control frames, sent raw rather than wrapped in an envelope.
 *
 * The relay treats a frame with a top-level `type` as its own; envelopes carry
 * only `peer`/`room`/`ct`. Subscription is per connection and the relay drops it
 * on disconnect, so it has to be re-sent after every reconnect.
 */
export type RelayControlRequest =
  | { type: 'subscribe_rooms'; peers: string[] }
  | { type: 'subscribe_presence'; peers: string[] }
  | { type: 'rooms_check'; peers: string[] }
  | { type: 'presence_check'; peers: string[] }

/** A transcript entry inside `session_history`. */
export interface RelaySessionEvent {
  type?: string
  role?: string
  content?: unknown
  [key: string]: unknown
}

const PAIR_URI_PREFIX = 'remotepi://pair?'
const TOKEN_MIN_LENGTH = 8

/**
 * Resolves the relay's HTTP endpoint, rejecting schemes the client cannot dial.
 * Mirrors remote-pi so a URL that works for the phone also works here.
 */
export function normalizeRelayUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  return trimmed.replace(/\/+$/, '')
}

/** Maps an HTTP relay URL onto the WebSocket URL used for the control socket. */
export function toWebSocketUrl(relayUrl: string): string {
  const normalized = normalizeRelayUrl(relayUrl)
  if (!normalized) throw new Error(`Unsupported relay URL: ${relayUrl}`)
  return normalized.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
}

export interface PairingUri {
  token: string
  /** Canonical base64 (not base64url) of the Pi's Ed25519 public key. */
  targetPubkey: string
  agentName: string
  roomId: string | null
}

function decodeBase64UrlToBase64(value: string): string | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const decoded = Buffer.from(normalized, 'base64')
  if (decoded.length !== 32) return null
  return decoded.toString('base64')
}

/**
 * Parses the `remotepi://pair?...` URI that `/remote-pi pair` prints.
 *
 * Returns null rather than throwing for anything malformed: the input is
 * user-pasted text.
 */
export function parsePairingUri(raw: string): PairingUri | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith(PAIR_URI_PREFIX)) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(trimmed.slice(PAIR_URI_PREFIX.length))
  } catch {
    return null
  }
  const token = params.get('t')
  const epk = params.get('epk')
  if (!token || token.length < TOKEN_MIN_LENGTH) return null
  if (!epk) return null
  const targetPubkey = decodeBase64UrlToBase64(epk)
  if (!targetPubkey) return null
  const roomId = params.get('rm')
  return {
    token,
    targetPubkey,
    agentName: (params.get('n') ?? '').slice(0, 80),
    roomId: roomId && roomId.length > 0 ? roomId : null,
  }
}

export function encodeEnvelope(inner: RelayClientMessage | RelayServerMessage, target: { peer: string; room?: string }): string {
  const envelope: RelayOuterEnvelope = {
    peer: target.peer,
    room: target.room ?? '',
    ct: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64'),
  }
  return JSON.stringify(envelope)
}

/** Returns null for frames that carry no inner message. */
export function decodeEnvelope(raw: string): { peer: string; room: string; inner: RelayServerMessage } | null {
  let outer: unknown
  try {
    outer = JSON.parse(raw)
  } catch {
    return null
  }
  if (!outer || typeof outer !== 'object') return null
  const frame = outer as Partial<RelayOuterEnvelope>
  if (typeof frame.ct !== 'string') return null
  let inner: unknown
  try {
    inner = JSON.parse(Buffer.from(frame.ct, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!inner || typeof inner !== 'object' || typeof (inner as { type?: unknown }).type !== 'string') {
    return null
  }
  return {
    peer: typeof frame.peer === 'string' ? frame.peer : '',
    room: typeof frame.room === 'string' ? frame.room : '',
    inner: inner as RelayServerMessage,
  }
}
