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
  /**
   * Persists a room the manager adopted from the roster.
   *
   * Separate from `onPaired` so the bridge can tell a user-initiated pairing,
   * which it has already saved, from a repair it did not ask for.
   */
  onAdopted?: (agent: PairedRelayAgent) => Promise<void> | void
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
  /** Peers we asked for a roster from and have not heard back about yet. */
  private readonly rosterRequests = new Set<string>()
  /** Peers whose roster arrived since the last `listRooms` call. */
  private readonly rosterReplies = new Set<string>()
  private rosterWaiter: (() => void) | null = null

  constructor(private readonly options: RelayManagerOptions) {
    super()
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.state = { status: 'idle', rooms: [], agent: options.initialAgent ?? null }
    this.wireTransport()
  }

  getState(): RelayManagerState {
    return { ...this.state, rooms: [...this.state.rooms] }
  }

  /** Notifies on every internal state change; returns an unsubscribe function. */
  onChange(listener: (state: RelayManagerState) => void): () => void {
    this.on('change', listener)
    return () => this.off('change', listener)
  }

  /**
   * Reports frames that are not a reply to one of our requests.
   *
   * These are the live ones — `agent_chunk`, `tool_request`, `session_history`
   * pushed unprompted — and `meta` carries the room so a caller can tell which
   * session a chunk belongs to. Typed here rather than left as a bare EventEmitter
   * event so the bridge cannot subscribe to the wrong name and silently see
   * nothing.
   */
  onMessage(listener: (message: RelayServerMessage, meta: { peer: string; room: string }) => void): () => void {
    this.on('message', listener)
    return () => this.off('message', listener)
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
    // Subscribing only registers interest; the relay pushes the CURRENT roster
    // to nobody, so without this check the list stays empty until some session
    // happens to start or stop. It also feeds room adoption on startup.
    this.options.transport.sendControl({ type: 'rooms_check', peers: [agent.pubkey] })
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
    // The room is not known until the Pi answers: a pairing link carries the
    // peer, not which of its rooms to use.
    const provisional: PairedRelayAgent = {
      pubkey: input.targetPubkey,
      agentName: input.agentName,
      roomId: input.roomId,
      pairedAt: new Date().toISOString(),
    }

    await this.ensureConnected()

    // Subscribe before pairing: the Pi announces its rooms as soon as it accepts,
    // and a subscription made afterwards would miss that first announcement.
    this.options.transport.sendControl({ type: 'subscribe_rooms', peers: [input.targetPubkey] })

    const reply = await this.request(
      { type: 'pair_request', id: '', token: input.token, device_name: defaultDeviceName() },
      { peer: input.targetPubkey, room: input.roomId },
    ).catch((error: unknown) => {
      // A silent drop is the usual symptom of the two machines sitting on
      // DIFFERENT relays: the relay never had this peer, so it discards the
      // frame instead of replying. Say that, because the bare timeout reads
      // like an expired link and sends people to re-run /remote-pi pair.
      if (error instanceof Error && error.message.includes('did not answer')) {
        throw new Error(
          `${error.message}. The other machine is not on this relay — check that both machines use the same relay URL (it is not carried in the pairing link).`,
        )
      }
      throw error
    })

    if (reply.type === 'pair_error') {
      const detail = reply.message ?? reply.code
      this.patch({ status: 'error', detail })
      throw new Error(detail)
    }

    // `pair_ok` names the room this Pi is in. Without it every later frame goes
    // out addressed to `(peer, '')`, which the relay drops on the floor because
    // it looks the pair up exactly.
    const accepted = reply.type === 'pair_ok' ? reply : null
    const agent: PairedRelayAgent = {
      ...provisional,
      agentName: accepted?.session_name ?? provisional.agentName,
      roomId: accepted?.room_id ?? provisional.roomId,
    }

    await this.options.onPaired?.(agent)
    this.patch({ status: 'paired', agent, rooms: [], detail: undefined })
    return agent
  }

  /**
   * Asks the paired Pi which sessions it currently have open.
   *
   * The relay answers with a separate `rooms` frame, so this waits for it
   * instead of returning whatever the last push happened to leave. A Pi that is
   * not connected to this relay never produces a frame, so the wait is bounded.
   */
  async listRooms(): Promise<RelayRoomInfo[]> {
    const target = this.requirePaired()
    await this.ensureConnected()

    this.rosterReplies.delete(target.peer)
    this.rosterRequests.add(target.peer)
    if (!this.options.transport.sendControl({ type: 'rooms_check', peers: [target.peer] })) {
      this.rosterRequests.delete(target.peer)
      throw new Error('The relay connection is not open')
    }

    await this.waitForRoster(target.peer)
    return this.getState().rooms
  }

  /** Resolves when `peer`'s roster arrives, or rejects once the timeout lapses. */
  private waitForRoster(peer: string): Promise<void> {
    if (this.rosterReplies.has(peer)) {
      this.clearRosterWait()
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearRosterWait()
        this.rosterRequests.delete(peer)
        reject(
          new Error(
            `The paired Pi did not report its sessions within ${this.requestTimeoutMs}ms. It may have no session open, or it may be on a different relay.`,
          ),
        )
      }, this.requestTimeoutMs)
      this.rosterWaiter = () => {
        clearTimeout(timer)
        this.clearRosterWait()
        resolve()
      }
    })
  }

  private clearRosterWait(): void {
    this.rosterWaiter = null
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

  /**
   * Points this desktop at one of the Pi's rooms.
   *
   * A Pi can run several sessions from the same folder (remote-pi names them
   * `open-shaders` and `open-shaders#2`), and the relay addresses frames by the
   * exact `(peer, room)` pair. Without a choice here, prompts would have no
   * target whenever a Pi has more than one room open.
   */
  async selectRoom(roomId: string): Promise<PairedRelayAgent> {
    const agent = this.state.agent
    if (!agent) throw new Error('This desktop is not paired with a Pi yet')
    const known = this.state.rooms.some((room) => room.room_id === roomId)
    if (!known) throw new Error('That session is no longer open on the paired Pi')
    const selected: PairedRelayAgent = { ...agent, roomId }
    this.patch({ agent: selected })
    await this.options.onPaired?.(selected)
    return selected
  }

  private requirePaired(): RelayTarget {
    const agent = this.state.agent
    if (!agent) throw new Error('This desktop is not paired with a Pi yet')
    return { peer: agent.pubkey, room: agent.roomId }
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

  /**
   * Fills in a missing room id from the roster.
   *
   * A pairing made before `pair_ok`'s room was persisted leaves this desktop
   * addressing `(peer, '')`, which the relay drops silently. Rather than make
   * the user pair again, adopt the room the Pi is actually advertising. Only
   * done once, and only when the roster offers exactly one candidate, so a Pi
   * running several sessions is never guessed at.
   */
  private adoptRoomFromRoster(): void {
    const agent = this.state.agent
    if (!agent) return
    const rooms = this.state.rooms
    // Only when there is exactly one candidate: with several sessions open the
    // choice is the user's, and guessing would drive the wrong one.
    if (rooms.length !== 1) return
    const roomId = rooms[0]?.room_id
    if (!roomId) return
    // Also re-adopt when the stored room has gone away. A Pi restarted, or the
    // session we were driving was closed, leaves a stale id that the relay
    // silently drops; the Pi having exactly one room makes that the right one.
    if (agent.roomId === roomId) return
    const repaired: PairedRelayAgent = { ...agent, roomId }
    this.patch({ agent: repaired })
    void this.options.onAdopted?.(repaired)
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
      // A `rooms_check` reply settles the matching wait; a broadcast also counts,
      // because either way the roster we now hold is fresh.
      this.rosterReplies.add(meta.peer)
      this.rosterRequests.delete(meta.peer)
      this.rosterWaiter?.()
      this.adoptRoomFromRoster()
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
