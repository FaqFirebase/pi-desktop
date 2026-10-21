/**
 * Owns the relay connection's lifetime and keeps it in step with settings.
 *
 * The renderer never touches a transport: it asks for state and issues intents,
 * and this decides whether a socket should exist at all. That keeps "did the
 * user pair" and "is the socket up" from being two competing sources of truth.
 */
import type { AppSettings, PairedRelayAgent, RelayStatus } from '../../shared/ipc-contracts'
import type { PairingUri, RelayRoomInfo } from '../../shared/relay-protocol'
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
  syncSession(): Promise<unknown>
  sendPrompt(text: string): Promise<void>
  cancel(): Promise<void>
  getState(): RelayManagerState
}

export class RelaySessionBridge {
  private manager: RelayManagerLike | null = null
  private readonly listeners = new Set<(status: RelayStatus) => void>()

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
    },
  ) {}

  onStatusChange(listener: (status: RelayStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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

  async syncSession(): Promise<unknown> {
    return this.requireManager().syncSession()
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
    if (this.manager) this.deps.disposeManager?.(this.manager)
    this.manager = null
    this.listeners.clear()
  }

  private async rebuild(): Promise<void> {
    if (this.manager) {
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
