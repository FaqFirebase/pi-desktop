/**
 * Adapts the raw `RelayClient` socket to the `RelayTransport` seam.
 *
 * Translation lives here so the manager never parses JSON and the socket never
 * learns the pairing rules.
 */
import { appLog } from '../app-log'
import { decodeEnvelope, encodeEnvelope, type RelayClientMessage, type RelayControlRequest, type RelayInboundMessage } from '../../shared/relay-protocol'
import { RelayClient } from './relay-client'
import type { RelayTarget, RelayTransport, RelayTransportEvents, RelayTransportState } from './relay-transport'

export class RelayClientTransport implements RelayTransport {
  private events: RelayTransportEvents | null = null
  private readonly client: RelayClient

  constructor(relayUrl: string, keypair: { publicKeyBase64: string; privateKeyPem: string }) {
    this.client = new RelayClient(relayUrl, keypair, {
      onFrame: (raw) => this.handleFrame(raw),
      onStateChange: (state, detail) => this.events?.onStateChange(state, detail),
    })
  }

  setEvents(events: RelayTransportEvents): void {
    this.events = events
  }

  connect(): Promise<void> {
    return this.client.connect()
  }

  close(): void {
    this.client.close()
  }

  getState(): RelayTransportState {
    return this.client.getState()
  }

  send(message: RelayClientMessage, target: RelayTarget): boolean {
    return this.client.send(encodeEnvelope(message, { peer: target.peer, room: target.room ?? undefined }))
  }

  sendControl(frame: RelayControlRequest): boolean {
    return this.client.send(JSON.stringify(frame))
  }

  private handleFrame(raw: string): void {
    // Control frames (challenge, presence) are the client's business.
    let parsed: { type?: unknown }
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof parsed.type === 'string') {
      if (parsed.type === 'rooms') {
        this.events?.onMessage(parsed as RelayInboundMessage, { peer: String((parsed as { peer?: unknown }).peer ?? ''), room: '' })
      }
      return
    }

    const decoded = decodeEnvelope(raw)
    if (!decoded) {
      appLog.warn('relay', 'Discarded a relay frame that carried no readable message')
      return
    }
    this.events?.onMessage(decoded.inner, { peer: decoded.peer, room: decoded.room })
  }
}
