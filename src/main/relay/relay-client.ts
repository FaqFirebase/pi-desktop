/**
 * Relay control-socket client: WebSocket + Ed25519 challenge-response.
 *
 * Implemented locally rather than importing remote-pi, whose entry point is a
 * Pi extension that pulls in the coding-agent SDK. The wire format lives in
 * `shared/relay-protocol.ts`.
 */
import WebSocket from 'ws'
import { toWebSocketUrl } from '../../shared/relay-protocol'
import { signChallenge, type RelayKeypair } from './identity'
import { appLog } from '../app-log'

const AUTH_TIMEOUT_MS = 10_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000

export type RelayConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

export interface RelayClientEvents {
  /** A raw control frame (auth, presence, rooms) or an opaque envelope. */
  onFrame: (raw: string) => void
  onStateChange: (state: RelayConnectionState, detail?: string) => void
}

/**
 * Owns one relay connection and re-establishes it after transport failures.
 *
 * Reconnecting rejoins the same room without re-pairing: the Pi keeps its room
 * open across our disconnects.
 */
export class RelayClient {
  private socket: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private closedByCaller = false
  private state: RelayConnectionState = 'idle'
  /** Settles once the current connection is authenticated, or rejects if it fails. */
  private settleAuth: { resolve: () => void; reject: (error: Error) => void } | null = null

  constructor(
    private readonly relayUrl: string,
    private readonly keypair: RelayKeypair,
    private readonly events: RelayClientEvents,
  ) {}

  getState(): RelayConnectionState {
    return this.state
  }

  /**
   * Opens the socket and resolves once it is AUTHENTICATED.
   *
   * Resolving on the socket 'open' event is not enough: the relay rejects every
   * frame sent before auth, so a caller that immediately sends a control frame
   * would silently lose it. Reconnects go through `openSocket` without a waiter.
   */
  async connect(): Promise<void> {
    this.closedByCaller = false
    // The promise is captured locally: auth can settle while `openSocket` is
    // still awaiting, and clearing the field there would make this return a
    // resolved value for a connection that actually failed.
    const settled = new Promise<void>((resolve, reject) => {
      this.settleAuth = { resolve, reject }
    })
    await this.openSocket()
    return settled
  }

  /** Marks the current connection authenticated and releases any `connect` waiter. */
  private markAuthenticated(): void {
    this.settleAuth?.resolve()
    this.settleAuth = null
  }

  /** Fails the pending `connect`, if any, so a caller does not hang on a dead socket. */
  private failAuth(error: Error): void {
    this.settleAuth?.reject(error)
    this.settleAuth = null
  }

  close(): void {
    this.closedByCaller = true
    this.clearReconnectTimer()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.removeAllListeners()
      try {
        socket.close()
      } catch {
        // Closing an already-closed socket throws.
      }
    }
    this.setState('idle')
  }

  /** Sends an already-encoded envelope. Returns false when the socket is not open. */
  send(payload: string): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(payload)
      return true
    } catch (error) {
      appLog.warn('relay', 'send failed', String(error))
      return false
    }
  }

  private setState(state: RelayConnectionState, detail?: string): void {
    if (this.state === state && !detail) return
    this.state = state
    this.events.onStateChange(state, detail)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private async openSocket(): Promise<void> {
    this.setState('connecting')
    const url = toWebSocketUrl(this.relayUrl)
    const socket = new WebSocket(url)
    this.socket = socket

    socket.on('open', () => {
      void this.authenticate(socket)
    })
    socket.on('message', (raw) => {
      this.events.onFrame(typeof raw === 'string' ? raw : raw.toString())
    })
    socket.on('error', (error) => {
      appLog.warn('relay', 'socket error', error.message)
    })
    socket.on('close', () => {
      this.socket = null
      if (this.closedByCaller) {
        this.setState('idle')
        return
      }
      this.setState('error', 'relay connection closed')
      this.failAuth(new Error('relay connection closed'))
      this.scheduleReconnect()
    })
  }

  private async authenticate(socket: WebSocket): Promise<void> {
    const hello = { type: 'hello', pubkey: this.keypair.publicKeyBase64 }
    socket.send(JSON.stringify(hello))

    const challengeRaw = await this.nextControlFrame(socket, ['challenge', 'error'])
    if (!challengeRaw) {
      this.setState('error', 'relay did not answer the hello')
      this.failAuth(new Error('relay did not answer the hello'))
      socket.close()
      return
    }
    const challenge = challengeRaw as { type: string; nonce?: string; code?: string; message?: string }
    if (challenge.type !== 'challenge' || typeof challenge.nonce !== 'string') {
      const detail = challenge.code ?? challenge.message ?? 'unexpected relay reply'
      this.setState('error', `relay rejected the hello: ${detail}`)
      this.failAuth(new Error(`relay rejected the hello: ${detail}`))
      socket.close()
      return
    }

    socket.send(JSON.stringify({ type: 'auth', sig: signChallenge(this.keypair, challenge.nonce) }))
    this.reconnectAttempt = 0
    this.setState('connected')
    this.markAuthenticated()
  }

  /**
   * Reads control frames until one of `wanted` arrives.
   *
   * Room and presence pushes can arrive before the challenge, so frames outside
   * `wanted` are skipped here and still delivered to `onFrame`.
   */
  private nextControlFrame(socket: WebSocket, wanted: readonly string[]): Promise<{ type: string } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.off('message', onMessage)
        resolve(null)
      }, AUTH_TIMEOUT_MS)

      function onMessage(raw: WebSocket.RawData): void {
        let frame: { type?: unknown }
        try {
          frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        } catch {
          return
        }
        if (typeof frame.type !== 'string') return
        if (!wanted.includes(frame.type)) return
        clearTimeout(timer)
        socket.off('message', onMessage)
        resolve(frame as { type: string })
      }

      socket.on('message', onMessage)
    })
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller || this.reconnectTimer) return
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closedByCaller) return
      void this.openSocket().catch((error) => {
        appLog.warn('relay', 'reconnect failed', String(error))
        this.scheduleReconnect()
      })
    }, delay)
  }
}
