import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { PairedRelayAgent } from '../../shared/ipc-contracts'
import { normalizeRelayUrl, parsePairingUri } from '../../shared/relay-protocol'
import { assertTrustedSender } from './validation'
import { appLog } from '../app-log'
import type { RelaySessionBridge } from '../relay/relay-bridge'

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

/** Reports a relay failure without leaking pairing material into the log. */
export function logRelayFailure(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  appLog.warn('relay', `Relay action failed: ${action}`, message)
}
