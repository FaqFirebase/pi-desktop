import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { DetectedRelay, PairedRelayAgent, RelayOpenResult, RemoteSessionRef } from '../../shared/ipc-contracts'
import { normalizeRelayUrl, parsePairingUri } from '../../shared/relay-protocol'
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

  ipcMain.handle(IPC_CHANNELS.RELAY_SEND_PROMPT, async (event, text: unknown) => {
    assertTrustedSender(event)
    if (typeof text !== 'string' || !text.trim()) throw new Error('A prompt cannot be empty')
    await bridge.sendPrompt(text)
    return { ok: true as const }
  })

  ipcMain.handle(IPC_CHANNELS.RELAY_CANCEL, async (event) => {
    assertTrustedSender(event)
    await bridge.cancel()
    return { ok: true as const }
  })
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
