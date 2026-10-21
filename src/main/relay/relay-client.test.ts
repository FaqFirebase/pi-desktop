import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { generateRelayKeypair, signChallenge, type RelayKeypair } from './identity'
import { RelayClient, type RelayConnectionState } from './relay-client'

interface FakeRelay {
  url: string
  /** Nonce the fake relay issued, so a test can assert the reported signature. */
  issuedNonce: () => string
  received: string[]
  /** Drops every open socket while keeping the server listening, to force a reconnect. */
  dropConnections: () => void
  close: () => Promise<void>
}

/**
 * Stands up a relay that speaks just enough of the protocol to authenticate a
 * client: it issues a challenge nonce and records whatever `sig` comes back.
 */
async function startFakeRelay(options: {
  nonce?: string
  expectPubkey?: string
  rejectHello?: { code: string; message?: string }
} = {}): Promise<FakeRelay> {
  const nonce = options.nonce ?? Buffer.from('fake-relay-nonce').toString('base64')
  const received: string[] = []
  const sockets = new Set<WebSocket>()

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', (raw) => {
      const text = raw.toString()
      received.push(text)
      const frame = JSON.parse(text) as { type?: string; pubkey?: string; sig?: string }
      if (frame.type === 'hello') {
        if (options.rejectHello) {
          socket.send(JSON.stringify({ type: 'error', ...options.rejectHello }))
          return
        }
        if (options.expectPubkey && frame.pubkey !== options.expectPubkey) {
          socket.send(JSON.stringify({ type: 'error', code: 'unknown_pubkey' }))
          return
        }
        socket.send(JSON.stringify({ type: 'challenge', nonce }))
        return
      }
      if (frame.type === 'auth') {
        socket.send(JSON.stringify({ type: 'presence', states: [] }))
      }
    })
  })

  return {
    url: `http://127.0.0.1:${port}`,
    issuedNonce: () => nonce,
    received,
    dropConnections: () => {
      for (const socket of sockets) socket.terminate()
    },
    close: async () => {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Waits for the client to report `wanted`, so tests never poll with sleeps. */
function waitForState(client: RelayClient, wanted: RelayConnectionState, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client.getState() === wanted) return resolve()
    const timer = setTimeout(() => reject(new Error(`timed out waiting for relay state ${wanted}`)), timeoutMs)
    const interval = setInterval(() => {
      if (client.getState() !== wanted) return
      clearTimeout(timer)
      clearInterval(interval)
      resolve()
    }, 10)
  })
}

/**
 * Waits until `read` reports `count`.
 *
 * The client marks itself connected as soon as it SENDS auth, so a test that
 * asserted on the relay's inbox right after `connected` raced the frame's
 * arrival and passed only by luck.
 */
function waitForCount(read: () => number, count: number, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (read() === count) return resolve()
    const timer = setTimeout(() => reject(new Error(`timed out waiting for count ${count} (saw ${read()})`)), timeoutMs)
    const interval = setInterval(() => {
      if (read() !== count) return
      clearTimeout(timer)
      clearInterval(interval)
      resolve()
    }, 10)
  })
}

const openRelays: FakeRelay[] = []
const openClients: RelayClient[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close()
  for (const relay of openRelays.splice(0)) await relay.close()
})

async function connectClient(relay: FakeRelay, keypair: RelayKeypair = generateRelayKeypair()) {
  const frames: string[] = []
  const client = new RelayClient(relay.url, keypair, {
    onFrame: (raw) => frames.push(raw),
    onStateChange: () => {},
  })
  openRelays.push(relay)
  openClients.push(client)
  await client.connect()
  return { client, frames, keypair }
}

test('client authenticates with hello then a signature over the relay nonce', async () => {
  const relay = await startFakeRelay()
  const { client, keypair } = await connectClient(relay)
  await waitForState(client, 'connected')

  await waitForCount(() => relay.received.length, 2)
  const hello = JSON.parse(relay.received[0])
  assert.deepEqual(hello, { type: 'hello', pubkey: keypair.publicKeyBase64 })

  const auth = JSON.parse(relay.received[1])
  assert.equal(auth.type, 'auth')
  assert.equal(auth.sig, signChallenge(keypair, relay.issuedNonce()))
})

test('client reports an error state when the relay rejects the hello', async () => {
  const relay = await startFakeRelay({ rejectHello: { code: 'unknown_pubkey', message: 'not paired' } })
  const { client } = await connectClient(relay)

  await waitForState(client, 'error')
  assert.equal(client.getState(), 'error')
})

test('client surfaces relay frames other than the challenge to onFrame', async () => {
  const relay = await startFakeRelay()
  const { client, frames } = await connectClient(relay)
  await waitForState(client, 'connected')

  const types = frames.map((raw) => (JSON.parse(raw) as { type: string }).type)
  assert.ok(types.includes('challenge'))
  assert.ok(types.includes('presence'))
})

test('send refuses to write before the socket is open', async () => {
  const keypair = generateRelayKeypair()
  const client = new RelayClient('http://127.0.0.1:1', keypair, { onFrame: () => {}, onStateChange: () => {} })
  openClients.push(client)
  assert.equal(client.send('{"type":"ping"}'), false)
})

test('send writes the payload once connected', async () => {
  const relay = await startFakeRelay()
  const { client } = await connectClient(relay)
  await waitForState(client, 'connected')

  assert.equal(client.send('{"type":"ping","id":"p1"}'), true)
  await waitForCount(() => relay.received.filter((raw) => raw.includes('"ping"')).length, 1)
})

test('close returns the client to idle and stops reconnecting', async () => {
  const relay = await startFakeRelay()
  const { client } = await connectClient(relay)
  await waitForState(client, 'connected')

  client.close()
  assert.equal(client.getState(), 'idle')

  const before = relay.received.length
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(relay.received.length, before, 'a closed client must not reconnect')
})

test('a dropped connection is retried on the same client and re-authenticated', async () => {
  const keypair = generateRelayKeypair()
  const relay = await startFakeRelay({ expectPubkey: keypair.publicKeyBase64 })
  const { client } = await connectClient(relay, keypair)
  await waitForState(client, 'connected')

  const handshakesBefore = relay.received.filter((raw) => raw.includes('"hello"')).length
  assert.equal(handshakesBefore, 1)

  // Drop the live socket while the server keeps listening: the client must
  // reconnect and re-run hello+auth by itself, with no new client instance.
  relay.dropConnections()
  await waitForCount(() => relay.received.filter((raw) => raw.includes('"hello"')).length, 2, 10_000)
  await waitForCount(() => relay.received.filter((raw) => raw.includes('"auth"')).length, 2, 10_000)
  await waitForState(client, 'connected', 10_000)
})

test('normalizeRelayUrl-compatible URLs only: a bad URL surfaces as an error state', async () => {
  const client = new RelayClient('ws://127.0.0.1:3000', generateRelayKeypair(), {
    onFrame: () => {},
    onStateChange: () => {},
  })
  openClients.push(client)
  await assert.rejects(() => client.connect(), /Unsupported relay URL/)
})
