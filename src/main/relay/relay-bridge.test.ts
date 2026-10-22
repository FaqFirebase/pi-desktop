import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import type { AppSettings, PairedRelayAgent } from '../../shared/ipc-contracts'
import type { RelayRoomInfo } from '../../shared/relay-protocol'
import { RelaySessionBridge, type RelayManagerLike } from './relay-bridge'
import type { RelayManagerState } from './relay-session-manager'

const AGENT: PairedRelayAgent = { pubkey: 'nJvBiqtqL1vZZNa0WpBynaj7EeNfq/g5fauzA516IcM=', agentName: 'macbook', roomId: 'room-abc', pairedAt: '2026-10-18T00:00:00.000Z' }
const ROOM: RelayRoomInfo = { cwd: '/Users/a/project', name: 'project', room_id: 'abc' }

class FakeManager implements RelayManagerLike {
  connected = false
  disconnected = false
  sent: string[] = []
  state: RelayManagerState = { status: 'idle', rooms: [], agent: null }

  async connect(): Promise<void> {
    this.connected = true
    this.state = { ...this.state, status: 'connected' }
  }
  disconnect(): void {
    this.disconnected = true
    this.state = { ...this.state, status: 'idle' }
  }
  async pair(input: Parameters<RelayManagerLike['pair']>[0]): Promise<PairedRelayAgent> {
    this.state = { ...this.state, status: 'paired', agent: AGENT }
    return { ...AGENT, agentName: input.agentName || AGENT.agentName }
  }
  async listRooms(): Promise<RelayRoomInfo[]> {
    return [ROOM]
  }
  async selectRoom(roomId: string): Promise<PairedRelayAgent> {
    this.state = { ...this.state, agent: { ...AGENT, roomId } }
    return { ...AGENT, roomId }
  }
  async syncSession(): Promise<unknown> {
    return { events: { type: 'session_history', events: [] } }
  }
  async sendPrompt(text: string): Promise<void> {
    this.sent.push(text)
  }
  async cancel(): Promise<void> {
    this.sent.push('<cancel>')
  }
  getState(): RelayManagerState {
    return this.state
  }
}

interface Harness {
  bridge: RelaySessionBridge
  settings: AppSettings
  managers: FakeManager[]
  savedAgents: (PairedRelayAgent | null)[]
  disposed: FakeManager[]
  hasKeypair: boolean
  ensuredKeypairs: number
}

function harness(
  initial: Partial<AppSettings> = {},
  options: { keypairError?: Error } = {},
): Harness {
  const state = {
    settings: { ...DEFAULT_SETTINGS, ...initial } as AppSettings,
    managers: [] as FakeManager[],
    savedAgents: [] as (PairedRelayAgent | null)[],
    disposed: [] as FakeManager[],
    hasKeypair: initial.relay?.pairedAgent != null || Boolean(initial.relay?.url),
    ensuredKeypairs: 0,
  }

  const bridge = new RelaySessionBridge({
    settings: {
      read: async () => state.settings,
      write: async (patch) => {
        state.settings = { ...state.settings, ...patch } as AppSettings
      },
    },
    peers: {
      ensure: async () => {
        if (options.keypairError) throw options.keypairError
        state.ensuredKeypairs += 1
        if (!state.hasKeypair) state.hasKeypair = true
        return { keypair: { publicKeyBase64: AGENT.pubkey, privateKeyPem: 'pem' }, agent: state.settings.relay.pairedAgent }
      },
      save: async (agent) => {
        state.savedAgents.push(agent)
      },
    },
    createManager: async () => {
      const manager = new FakeManager()
      state.managers.push(manager)
      return manager
    },
    disposeManager: (manager) => state.disposed.push(manager as FakeManager),
  })

  return {
    bridge,
    get settings() {
      return state.settings
    },
    get ensuredKeypairs() {
      return state.ensuredKeypairs
    },
    managers: state.managers,
    savedAgents: state.savedAgents,
    disposed: state.disposed,
    get hasKeypair() {
      return state.hasKeypair
    },
  }
}

test('start does nothing when the relay was never configured', async () => {
  const subject = harness()
  await subject.bridge.start()
  assert.equal(subject.managers.length, 0)
  const status = await subject.bridge.getStatus()
  assert.equal(status.connection.status, 'idle')
  assert.equal(status.settings.enabled, false)
})

test('start connects once a url and keypair exist', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://192.168.1.223:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  assert.equal(subject.managers.length, 1)
  assert.equal(subject.managers[0].connected, true)
})

test('a fresh install mints a keypair before connecting, so pairing can start', async () => {
  // No stored keypair: `ensure` is what mints one, and pairing is impossible
  // without it because the key is the peer id the Pi records.
  const subject = harness({ relay: { enabled: true, url: 'http://192.168.1.223:3000', pairedAgent: null } })
  await subject.bridge.start()
  assert.equal(subject.ensuredKeypairs, 1)
  assert.equal(subject.managers.length, 1)
})

test('a keypair that cannot be created blocks the connection without throwing', async () => {
  // A broken userData directory must not take the app down at startup, and it
  // must not silently connect under an identity the Pi never recorded.
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: null } }, {
    keypairError: new Error('EACCES'),
  })
  await subject.bridge.start()
  assert.equal(subject.managers.length, 0)
  assert.equal((await subject.bridge.getStatus()).connection.status, 'idle')
})

test('setting a url enables the relay and builds a connection', async () => {
  const subject = harness()
  const status = await subject.bridge.setUrl('http://192.168.1.223:3000')
  assert.equal(subject.settings.relay.url, 'http://192.168.1.223:3000')
  assert.equal(subject.settings.relay.enabled, true)
  assert.equal(subject.managers.length, 1)
  assert.equal(status.settings.enabled, true)
})

test('clearing the url disables the relay and disposes the live manager', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://192.168.1.223:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  assert.equal(subject.managers.length, 1)

  const status = await subject.bridge.setUrl(null)
  assert.equal(subject.settings.relay.enabled, false)
  assert.equal(subject.settings.relay.url, null)
  assert.equal(subject.disposed.length, 1, 'the old socket must be closed before a new one exists')
  assert.equal(status.settings.enabled, false)
})

test('changing the url disposes the previous manager rather than running two sockets', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  await subject.bridge.setUrl('http://b:3000')

  assert.equal(subject.disposed.length, 1)
  assert.equal(subject.managers.length, 2)
  const first = subject.managers[0]
  assert.equal(subject.disposed[0], first)
})

test('pairing persists the agent returned by the Pi', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: null } })
  await subject.bridge.start()

  const agent = await subject.bridge.pair({ token: 'tok', targetPubkey: AGENT.pubkey, agentName: 'macbook', roomId: null })
  assert.equal(agent.pubkey, AGENT.pubkey)
  assert.equal(subject.savedAgents.length, 1)
  assert.equal(subject.savedAgents[0]?.pubkey, AGENT.pubkey)
})

test('unpairing clears the stored agent and keeps the manager usable for re-pairing', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()

  const status = await subject.bridge.unpair()
  assert.equal(subject.savedAgents.at(-1), null)
  assert.equal(status.settings.pairedAgent, null)
  assert.equal(subject.disposed.length, 1)
})

test('actions refuse to run when there is no connection at all', async () => {
  const subject = harness()
  await assert.rejects(() => subject.bridge.syncSession(), /Set a relay URL and pair/)
  await assert.rejects(() => subject.bridge.sendPrompt('hi'), /Set a relay URL and pair/)
  await assert.rejects(() => subject.bridge.cancel(), /Set a relay URL and pair/)
  await assert.rejects(() => subject.bridge.listRooms(), /Set a relay URL and pair/)
})

test('prompting and cancelling reach the manager once connected', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()

  await subject.bridge.sendPrompt('run the tests')
  await subject.bridge.cancel()
  assert.deepEqual(subject.managers[0].sent, ['run the tests', '<cancel>'])
})

test('a connection failure at startup is reported, not thrown', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  const original = FakeManager.prototype.connect
  FakeManager.prototype.connect = async () => {
    throw new Error('relay unreachable')
  }
  try {
    await subject.bridge.start()
  } finally {
    FakeManager.prototype.connect = original
  }
  const status = await subject.bridge.getStatus()
  // The manager still exists so the transport's own retry can take over.
  assert.equal(subject.managers.length, 1)
  assert.equal(status.connection.status, 'idle')
})

test('status never carries the keypair or a pairing token', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  const serialized = JSON.stringify(await subject.bridge.getStatus())
  assert.equal(serialized.includes('privateKeyPem'), false)
  assert.equal(serialized.includes('token'), false)
})
