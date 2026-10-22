/**
 * Owns the relay connection's lifetime and keeps it in step with settings.
 *
 * The renderer never touches a transport: it asks for state and issues intents,
 * and this decides whether a socket should exist at all. That keeps "did the
 * user pair" and "is the socket up" from being two competing sources of truth.
 */
import type { AppSettings, PairedRelayAgent, RelayFrameEvent, RelayOpenResult, RelayStatus, RemoteSessionRef, RemoteSessionRow, SessionListItem } from '../../shared/ipc-contracts'
import type { PairingUri, RelayRoomInfo, RelayServerMessage, RelaySessionEvent } from '../../shared/relay-protocol'
import { appLog } from '../app-log'
import type { RelayKeypair } from './identity'
import type { RelayManagerState } from './relay-session-manager'

export type { RelayStatus } from '../../shared/ipc-contracts'

/** The slice of settings storage the bridge needs, injected for testability. */
export interface RelaySettingsStore {
  read(): Promise<AppSettings>
  write(patch: Partial<AppSettings>): Promise<void>
}

/**
 * This desktop's relay identity and paired Pi.
 *
 * `ensure` mints a keypair on first use rather than returning "not found": the
 * key IS this desktop's peer identity, so a fresh install has to obtain one
 * before a pairing token can even be presented. Minting only on demand keeps
 * machines that never enable the relay from acquiring a stray identity.
 */
export interface RelayPeerIdentity {
  keypair: RelayKeypair
  agent: PairedRelayAgent | null
}

export interface RelayPeerPersistence {
  ensure(): Promise<RelayPeerIdentity | null>
  save(agent: PairedRelayAgent | null): Promise<void>
}

/** The manager surface the bridge drives; a fake stands in for it in tests. */
export interface RelayManagerLike {
  connect(): Promise<void>
  disconnect(): void
  pair(input: PairingUri): Promise<PairedRelayAgent>
  listRooms(): Promise<RelayRoomInfo[]>
  selectRoom(roomId: string): Promise<PairedRelayAgent>
  syncSession(): Promise<unknown>
  sendPrompt(text: string): Promise<void>
  cancel(): Promise<void>
  getState(): RelayManagerState
  /** Reports every internal state change, including roster pushes and room adoption. */
  onChange(listener: (state: RelayManagerState) => void): () => void
  /** Reports live frames that are not replies to our own requests. */
  onMessage?(listener: (message: RelayServerMessage, meta: { peer: string; room: string }) => void): () => void
}

export class RelaySessionBridge {
  private manager: RelayManagerLike | null = null
  private unsubscribeManager: (() => void) | null = null
  private unsubscribeFrames: (() => void) | null = null
  private readonly listeners = new Set<(status: RelayStatus) => void>()
  private readonly frameListeners = new Set<(event: RelayFrameEvent) => void>()

  constructor(
    private readonly deps: {
      settings: RelaySettingsStore
      peers: RelayPeerPersistence
      /** Builds a manager for a url+keypair; returns null when they are unusable. */
      createManager: (
        relayUrl: string,
        keypair: RelayKeypair,
        agent: PairedRelayAgent | null,
      ) => Promise<RelayManagerLike | null>
      /** Drops the live manager, e.g. after the url changes. */
      disposeManager?: (manager: RelayManagerLike) => void
      /**
       * Persists a pairing the manager adopted rather than the user making it.
       *
       * A Pi that restarts advertises a new room id, and the manager repairs its
       * own state from the roster; without this the repair lives only in memory
       * and the next launch addresses the dead room again.
       */
      persistAgent?: (agent: PairedRelayAgent) => Promise<void>
    },
  ) {}

  onStatusChange(listener: (status: RelayStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Streams live Pi frames to whoever is driving the remote session.
   *
   * Kept separate from `onStatusChange` because these are high-frequency and
   * per-room: a status listener that also saw chunks would have to filter them
   * all out again.
   */
  onFrame(listener: (event: RelayFrameEvent) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  async getStatus(): Promise<RelayStatus> {
    const settings = await this.deps.settings.read()
    const manager = this.manager
    return {
      settings: settings.relay,
      connection: manager
        ? manager.getState()
        : { status: 'idle', rooms: [], agent: settings.relay.pairedAgent },
    }
  }

  /**
   * Stores a relay url and rebuilds the connection.
   *
   * The old manager is disposed first: two sockets against the same pubkey
   * would authenticate twice and the relay would treat them as one peer, which
   * makes the roster flap between the two connections' room sets.
   */
  async setUrl(url: string | null): Promise<RelayStatus> {
    const settings = await this.deps.settings.read()
    await this.deps.settings.write({ relay: { ...settings.relay, url, enabled: url !== null } })
    await this.rebuild()
    return this.getStatus()
  }

  async pair(input: PairingUri): Promise<PairedRelayAgent> {
    const manager = this.requireManager()
    const agent = await manager.pair(input)
    await this.deps.peers.save(agent)
    const settings = await this.deps.settings.read()
    await this.deps.settings.write({ relay: { ...settings.relay, pairedAgent: agent } })
    this.emitStatus()
    return agent
  }

  async unpair(): Promise<RelayStatus> {
    await this.deps.peers.save(null)
    const settings = await this.deps.settings.read()
    await this.deps.settings.write({ relay: { ...settings.relay, pairedAgent: null } })
    await this.rebuild()
    return this.getStatus()
  }

  async listRooms(): Promise<RelayRoomInfo[]> {
    return this.requireManager().listRooms()
  }

  /** Chooses which of the paired Pi's rooms this desktop drives. */
  async selectRoom(roomId: string): Promise<RelayStatus> {
    await this.requireManager().selectRoom(roomId)
    this.emitStatus()
    return this.getStatus()
  }

  async syncSession(): Promise<unknown> {
    return this.requireManager().syncSession()
  }

  /**
   * The paired Pi's sessions as ordinary session rows.
   *
   * Each live room becomes one row so the sidebar can render local and remote
   * sessions from a single list instead of a separate remote-only section. The
   * room is re-read from the relay on every call because rooms come and go as
   * sessions are opened and closed.
   */
  async sessions(): Promise<RemoteSessionRow[]> {
    const manager = this.manager
    if (!manager) return []
    const state = manager.getState()
    const agent = state.agent
    if (!agent) return []
    const rooms = await manager.listRooms().catch((error: unknown) => {
      // A Pi with no session open is the ordinary case, not a failure worth
      // surfacing: the list simply has no remote rows.
      appLog.info('relay', 'No remote sessions listed', String(error))
      return []
    })
    return rooms.map((room) => toRemoteSessionRow(room, agent, state.detail))
  }

  /**
   * Binds the chat view to one remote session and returns its transcript.
   *
   * Selecting the room before syncing matters: the relay addresses frames by the
   * exact `(peer, room)` pair, so a sync sent while pointed at a different room is
   * delivered to the wrong session or dropped.
   */
  async openSession(target: RemoteSessionRef): Promise<RelayOpenResult> {
    const manager = this.requireManager()
    await manager.selectRoom(target.roomId)
    this.emitStatus()
    const reply = await manager.syncSession()
    const history = reply as { events?: RelaySessionEvent[]; session_started_at?: number; truncated?: boolean; session_name?: string } | null
    return {
      ref: target,
      sessionName: history?.session_name ?? target.roomId,
      sessionStartedAt: typeof history?.session_started_at === 'number' ? history.session_started_at : 0,
      truncated: history?.truncated === true,
      events: Array.isArray(history?.events) ? history.events : [],
    }
  }

  async sendPrompt(text: string): Promise<void> {
    await this.requireManager().sendPrompt(text)
  }

  async cancel(): Promise<void> {
    await this.requireManager().cancel()
  }

  /** Called once at startup: connect only if the user has already configured a relay. */
  async start(): Promise<void> {
    const settings = await this.deps.settings.read()
    if (!settings.relay.enabled || !settings.relay.url) return
    await this.rebuild()
  }

  dispose(): void {
    this.unsubscribeManager?.()
    this.unsubscribeManager = null
    this.unsubscribeFrames?.()
    this.unsubscribeFrames = null
    if (this.manager) this.deps.disposeManager?.(this.manager)
    this.manager = null
    this.listeners.clear()
    this.frameListeners.clear()
  }

  private async rebuild(): Promise<void> {
    if (this.manager) {
      this.unsubscribeManager?.()
      this.unsubscribeManager = null
      this.unsubscribeFrames?.()
      this.unsubscribeFrames = null
      this.deps.disposeManager?.(this.manager)
      this.manager = null
    }

    const settings = await this.deps.settings.read()
    const { relay } = settings
    if (!relay.enabled || !relay.url) {
      this.emitStatus()
      return
    }

    let peers: RelayPeerIdentity | null = null
    try {
      peers = await this.deps.peers.ensure()
    } catch (error) {
      appLog.warn('relay', "Could not create or read this desktop's relay keypair", String(error))
    }
    if (!peers) {
      this.emitStatus()
      return
    }

    const manager = await this.deps.createManager(relay.url, peers.keypair, relay.pairedAgent ?? peers.agent)
    if (!manager) {
      appLog.warn('relay', 'Could not create a relay connection for the stored configuration')
      this.emitStatus()
      return
    }
    this.manager = manager
    // Without this the renderer only sees state at the moment it asks, so a
    // roster push or a room adoption never reaches the panel.
    this.unsubscribeManager?.()
    this.unsubscribeManager = manager.onChange((state) => {
      for (const listener of this.listeners) {
        void this.getStatus().then((status) => listener({ ...status, connection: state }))
      }
    })
    // Live frames are what make a remote session behave like a local one: without
    // this the transcript would only ever be a snapshot from the last sync.
    this.unsubscribeFrames?.()
    this.unsubscribeFrames = manager.onMessage?.((frame, meta) => {
      // `pair_ok`/`pair_error` settle a paired request and never reach here, so
      // anything arriving is either a broadcast or a reply we did not ask for.
      const event: RelayFrameEvent = { roomId: meta.room || this.manager?.getState().agent?.roomId || '', frame }
      for (const listener of this.frameListeners) listener(event)
    }) ?? null
    try {
      await manager.connect()
    } catch (error) {
      appLog.warn('relay', 'Initial relay connection failed; it will retry', String(error))
    }
    this.emitStatus()
  }

  private requireManager(): RelayManagerLike {
    if (!this.manager) {
      throw new Error('Set a relay URL and pair with a Pi before using the relay')
    }
    return this.manager
  }

  private emitStatus(): void {
    if (this.listeners.size === 0) return
    void this.getStatus().then((status) => {
      for (const listener of this.listeners) listener(status)
    })
  }
}

/**
 * Turns a live room into a row the sidebar can render next to local sessions.
 *
 * The shape is `SessionListItem` on purpose. `path` is a synthetic locator rather
 * than a real file, because a remote session has no file on this disk; it is
 * unique per (peer, room) so the store's `path ===` comparisons keep working and
 * React keys stay stable.
 */
function toRemoteSessionRow(
  room: RelayRoomInfo,
  agent: PairedRelayAgent,
  _detail?: string,
): RemoteSessionRow {
  const folderName = room.cwd.split(/[\\/]/).filter(Boolean).pop() || room.cwd || room.room_id
  const startedAt = typeof room.started_at === 'number' && room.started_at > 0 ? room.started_at : Date.now()
  const session: SessionListItem = {
    path: remoteSessionPath(agent.pubkey, room.room_id),
    name: room.name || folderName,
    preview: null,
    contentState: 'unknown',
    sessionId: room.room_id,
    lastModified: startedAt,
    // The relay does not report a per-room message count; 0 would read as "empty
    // session" in the sidebar, so leave it at 1 to mean "exists, unknown size".
    messageCount: 1,
    projectPath: room.cwd,
    projectName: folderName,
    remote: { peer: agent.pubkey, roomId: room.room_id, hostname: agent.agentName || undefined },
  }
  return { session, ref: session.remote! }
}

/** A stable, unique stand-in for a session file path. Never used as a real path. */
export function remoteSessionPath(peer: string, roomId: string): string {
  return `remote://${peer}/${roomId}`
}
