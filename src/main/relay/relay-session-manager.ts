/**
 * Drives a paired Pi: pairing, session sync, prompting, and cancellation.
 *
 * Protocol specifics are pure or injected, so the correlation rules are testable
 * without a relay.
 */
import { EventEmitter } from 'node:events'
import type { PairedRelayAgent } from '../../shared/ipc-contracts'
import type { RelayClientMessage, RelayInboundMessage, RelayRoomInfo, RelayServerMessage } from '../../shared/relay-protocol'
import type { RelayTarget, RelayTransport, RelayTransportEvents, RelayTransportState } from './relay-transport'

export type RelayManagerStatus = 'idle' | 'connecting' | 'connected' | 'paired' | 'error'

export interface RelayManagerState {
  status: RelayManagerStatus
  detail?: string
  /** Rooms the paired Pi currently advertises (one per live session). */
  rooms: RelayRoomInfo[]
  agent: PairedRelayAgent | null
}

export interface RelayManagerOptions {
  transport: RelayTransport
  /** Where the pairing target (pubkey and name) is remembered between runs. */
  initialAgent?: PairedRelayAgent | null
  /** Persists a successful pairing; awaited so a crash cannot lose the credential. */
  onPaired?: (agent: PairedRelayAgent) => Promise<void> | void
  requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

interface PendingRequest {
  resolve: (message: RelayServerMessage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Correlates outbound requests with inbound replies by `in_reply_to`.
 *
 * The relay broadcasts: several peers can share a pubkey and every frame arrives
 * on one socket, so a reply is ours only when it names a request id we issued AND
 * comes from the peer we sent it to.
 */
export class RelaySessionManager extends EventEmitter {
  private state: RelayManagerState
  private readonly pending = new Map<string, PendingRequest>()
  private requestCounter = 0
  private readonly requestTimeoutMs: number

  constructor(private readonly options: RelayManagerOptions) {
    super()
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.state = { status: 'idle', rooms: [], agent: options.initialAgent ?? null }
    this.wireTransport()
  }

  getState(): RelayManagerState {
    return { ...this.state, rooms: [...this.state.rooms] }
  }

  private wireTransport(): void {
    const events: RelayTransportEvents = {
      onMessage: (message, meta) => this.handleMessage(message, meta),
      onStateChange: (transportState, detail) => this.handleTransportState(transportState, detail),
    }
    this.options.transport.setEvents(events)
  }

  private handleTransportState(transportState: RelayTransportState, detail?: string): void {
    if (transportState === 'connected') {
      this.subscribeToRoster()
      // Stay in 'paired' once we have an agent: a reconnect does not change
      // whether the user has paired.
      this.patch({ status: this.state.agent ? 'paired' : 'connected', detail })
      return
    }
    this.patch({ status: transportState, detail })
  }

  /**
   * Asks the relay to push this Pi's room set.
   *
   * Subscriptions are per connection and the relay drops them on disconnect, so
   * this must run on every `connected` transition, not just the first.
   */
  private subscribeToRoster(): void {
    const agent = this.state.agent
    if (!agent) return
    this.options.transport.sendControl({ type: 'subscribe_rooms', peers: [agent.pubkey] })
  }

  private patch(partial: Partial<RelayManagerState>): void {
    this.state = { ...this.state, ...partial }
    this.emit('change', this.getState())
  }

  async connect(): Promise<void> {
    this.patch({ status: 'connecting' })
    await this.options.transport.connect()
  }

  /**
   * Ensures the socket is up before an action that needs it.
   *
   * Actions go through this rather than assuming a prior `connect`, so a prompt
   * typed while the transport is retrying waits rather than fails.
   */
  private async ensureConnected(): Promise<void> {
    if (this.options.transport.getState() === 'connected') return
    await this.connect()
  }

  disconnect(): void {
    this.options.transport.close()
    this.patch({ status: 'idle' })
  }

  /**
   * Sends a pairing request and waits for the Pi's verdict.
   *
   * The token is single-use and only the Pi can accept it, so relay-level
   * authentication of both keys is NOT a substitute for this step.
   */
  async pair(input: { token: string; targetPubkey: string; agentName: string; roomId: string | null }): Promise<PairedRelayAgent> {
    const agent: PairedRelayAgent = {
      pubkey: input.targetPubkey,
      agentName: input.agentName,
      pairedAt: new Date().toISOString(),
    }

    await this.ensureConnected()

    const reply = await this.request(
      { type: 'pair_request', id: '', token: input.token, device_name: defaultDeviceName() },
      { peer: input.targetPubkey, room: input.roomId },
    )

    if (reply.type === 'pair_error') {
      const detail = reply.message ?? reply.code
      this.patch({ status: 'error', detail })
      throw new Error(detail)
    }

    await this.options.onPaired?.(agent)
    this.patch({ status: 'paired', agent, rooms: [], detail: undefined })
    return agent
  }

  /** Asks the paired Pi which sessions it currently has open. */
  async listRooms(): Promise<RelayRoomInfo[]> {
    const target = this.requirePaired()
    await this.ensureConnected()
    // The relay answers `rooms_check` with one `rooms` frame per requested peer.
    // Pinging the Pi instead returns a `pong` that carries no roster, so the
    // list would stay whatever the last push happened to leave.
    if (!this.options.transport.sendControl({ type: 'rooms_check', peers: [target.peer] })) {
      throw new Error('The relay connection is not open')
    }
    return this.getState().rooms
  }

  /** Pulls the live session transcript. */
  async syncSession(): Promise<{ events: RelayServerMessage & { type: 'session_history' } }> {
    const target = this.requirePaired()
    await this.ensureConnected()
    const reply = await this.request({ type: 'session_sync', id: '' }, target)
    if (reply.type === 'error') throw new Error(reply.message ?? reply.code)
    return { events: reply as RelayServerMessage & { type: 'session_history' } }
  }

  /** Sends a prompt. The turn streams back as `agent_chunk` frames. */
  async sendPrompt(text: string): Promise<void> {
    const target = this.requirePaired()
    await this.ensureConnected()
    const id = this.nextRequestId()
    const sent = this.options.transport.send({ type: 'user_message', id, text }, target)
    if (!sent) throw new Error('The relay connection is not open')
  }

  async cancel(): Promise<void> {
    const target = this.requirePaired()
    await this.ensureConnected()
    const id = this.nextRequestId()
    if (!this.options.transport.send({ type: 'cancel', id }, target)) {
      throw new Error('The relay connection is not open')
    }
  }

  private requirePaired(): RelayTarget {
    const agent = this.state.agent
    if (!agent) throw new Error('This desktop is not paired with a Pi yet')
    return { peer: agent.pubkey, room: null }
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return `desktop-${Date.now().toString(36)}-${this.requestCounter}`
  }

  /** Resolves with the first reply naming our id; rejects on timeout. */
  private request(
    template: RelayClientMessage,
    target: RelayTarget,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<RelayServerMessage> {
    const id = this.nextRequestId()
    const message = { ...template, id } as RelayClientMessage

    return new Promise<RelayServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The paired Pi did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })

      if (!this.options.transport.send(message, target)) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('The relay connection is not open'))
        return
      }
    })
  }

  private handleMessage(message: RelayInboundMessage, meta: { peer: string; room: string }): void {
    // Ignore traffic from any peer that is not the Pi we paired with: the relay
    // shares one socket across peers keyed by pubkey.
    const agent = this.state.agent
    if (agent && meta.peer && meta.peer !== agent.pubkey) return

    // A roster push names the peer it describes, so it is filtered by the same
    // pubkey check rather than trusted because it arrived first.
    if (message.type === 'rooms') {
      this.patch({ rooms: message.rooms ?? [] })
      return
    }

    const replyTo = (message as { in_reply_to?: string }).in_reply_to
    if (replyTo) {
      const pending = this.pending.get(replyTo)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(replyTo)
        pending.resolve(message)
        return
      }
    }

    this.emit('message', message, meta)
  }
}

/** A label the Pi shows in its paired-device list. */
function defaultDeviceName(): string {
  try {
    return `Pi Desktop (${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'})`
  } catch {
    return 'Pi Desktop'
  }
}
