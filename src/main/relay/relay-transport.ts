/**
 * The seam between the session manager and the socket, so the manager's
 * correlation rules are testable against a scripted transport.
 */
import type { RelayClientMessage, RelayControlRequest, RelayInboundMessage } from '../../shared/relay-protocol'

export type RelayTransportState = 'idle' | 'connecting' | 'connected' | 'error'

export interface RelayTarget {
  /** Canonical base64 Ed25519 public key of the Pi. */
  peer: string
  room: string | null
}

/** Events the transport reports; decoded, so the manager never parses JSON. */
export interface RelayTransportEvents {
  onMessage: (message: RelayInboundMessage, meta: { peer: string; room: string }) => void
  onStateChange: (state: RelayTransportState, detail?: string) => void
}

export interface RelayTransport {
  setEvents(events: RelayTransportEvents): void
  connect(): Promise<void>
  close(): void
  send(message: RelayClientMessage, target: RelayTarget): boolean
  /** Sends a relay-level control frame, which is not addressed to a peer. */
  sendControl(frame: RelayControlRequest): boolean
  getState(): RelayTransportState
}
