/**
 * Produces the concrete relay dependencies for the running app.
 *
 * Everything impure lives here so the bridge and the session manager stay
 * testable: this module is the only place that touches Electron's paths, the
 * settings file, and the socket.
 */
import { app } from 'electron'
import type { AppSettings, PairedRelayAgent } from '../../shared/ipc-contracts'
import { appLog } from '../app-log'
import { loadAppSettings, saveAppSettings } from '../ipc/settings'
import type { WorkspaceManager } from '../workspace-manager'
import { RelaySessionBridge, type RelayPeerIdentity, type RelayPeerPersistence, type RelaySettingsStore } from './relay-bridge'
import { RelayClientTransport } from './relay-client-transport'
import { generateRelayKeypair } from './identity'
import { readRelayPeer, writeRelayPeer } from './relay-peer-store'
import { RelaySessionManager } from './relay-session-manager'

/** Settings access for the bridge, going through the app's own settings file. */
class ElectronSettingsStore implements RelaySettingsStore {
  constructor(private readonly workspaceManager: WorkspaceManager) {}

  read(): Promise<AppSettings> {
    return loadAppSettings(this.workspaceManager)
  }

  async write(patch: Partial<AppSettings>): Promise<void> {
    await saveAppSettings(patch)
  }
}

/**
 * Keypair persistence, minting on first use.
 *
 * `ensure` is deliberately not `load`: the key IS this desktop's peer identity,
 * so it has to exist before a pairing token can be presented, and it must never
 * be regenerated once the Pi has recorded it.
 */
class FileRelayPeerPersistence implements RelayPeerPersistence {
  constructor(private readonly userDataDir: string) {}

  async ensure(): Promise<RelayPeerIdentity> {
    const existing = await readRelayPeer(this.userDataDir)
    if (existing) return { keypair: existing.keypair, agent: toAgent(existing.target) }

    const record = { keypair: generateRelayKeypair(), target: null }
    await writeRelayPeer(this.userDataDir, record)
    appLog.info('relay', 'Created this desktop\'s relay keypair')
    return { keypair: record.keypair, agent: null }
  }

  async save(agent: PairedRelayAgent | null): Promise<void> {
    const existing = await readRelayPeer(this.userDataDir)
    if (!existing) {
      // Saving a pairing without a keypair would create one with the wrong
      // identity, so mint first and keep the pair consistent.
      const minted = await this.ensure()
      await writeRelayPeer(this.userDataDir, { keypair: minted.keypair, target: agent ? toTarget(agent) : null })
      return
    }
    await writeRelayPeer(this.userDataDir, { keypair: existing.keypair, target: agent ? toTarget(agent) : null })
  }
}

function toAgent(target: { pubkey: string; agentName: string; roomId: string | null; pairedAt: string } | null): PairedRelayAgent | null {
  if (!target) return null
  return { pubkey: target.pubkey, agentName: target.agentName, roomId: target.roomId, pairedAt: target.pairedAt }
}

function toTarget(agent: PairedRelayAgent) {
  return { pubkey: agent.pubkey, agentName: agent.agentName, roomId: agent.roomId, pairedAt: agent.pairedAt }
}

/** Builds the bridge the IPC handlers and the app lifecycle share. */
export function createRelayBridge(workspaceManager: WorkspaceManager): RelaySessionBridge {
  const settings = new ElectronSettingsStore(workspaceManager)
  const peers = new FileRelayPeerPersistence(app.getPath('userData'))
  return new RelaySessionBridge({
    settings,
    peers,
    createManager: async (relayUrl, keypair, agent) => {
      const transport = new RelayClientTransport(relayUrl, keypair)
      return new RelaySessionManager({
        transport,
        initialAgent: agent,
        // A room repaired from the roster must outlive the process, or the next
        // launch addresses the room that just died.
        onAdopted: async (adopted) => {
          await peers.save(adopted)
          const current = await settings.read()
          await settings.write({ relay: { ...current.relay, pairedAgent: adopted } })
        },
      })
    },
    disposeManager: (manager) => manager.disconnect(),
  })
}
