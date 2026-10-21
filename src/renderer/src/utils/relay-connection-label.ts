import type { Translate } from '../../../shared/i18n'
import type { RelayConnectionStatus } from '../../../shared/ipc-contracts'

/**
 * The label for a relay connection state, shared by every surface that shows
 * one. The translator parameter is named `t` so `i18next-cli` finds the keys.
 */
export function relayConnectionLabel(status: RelayConnectionStatus, t: Translate): string {
  switch (status) {
    case 'idle':
      return t('settings.relay.connection.idle')
    case 'connecting':
      return t('settings.relay.connection.connecting')
    case 'connected':
      return t('settings.relay.connection.connected')
    case 'paired':
      return t('settings.relay.connection.paired')
    case 'error':
      return t('settings.relay.connection.error')
  }
}
