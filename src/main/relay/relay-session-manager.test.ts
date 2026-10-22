import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RelaySessionManager } from './relay-session-manager'
import type { RelayTarget, RelayTransport, RelayTransportEvents, RelayTransportState } from './relay-transport'
import type { RelayClientMessage, RelayControlRequest, RelayServerMessage } from '../../shared/relay-protocol'

const PI_PUBKEY = 'nJvBiqtqL1vZZNa0WpBynaj7EeNfq/g5fauzA516IcM='
const OTHER_PUBKEY = 'Zm9yZWlnbi1waS1wdWJsaWMta2V5LXRoYXQtaXMtb3V0c2lkZQ=='

/** A transport that records sends and lets a test push inbound frames. */
class ScriptedTransport implements RelayTransport {
  readonly sent: { message: RelayClientMessage; target: RelayTarget }[] = []
  readonly control: RelayControlRequest[] = []
  private events: RelayTransportEvents | null = null
  private state: RelayTransportState = 'idle'
  connectCalls = 0

  setEvents(events: RelayTransportEvents): void {
    this.events = events
  }

  connect(): Promise<void> {
    this.connectCalls += 1
    this.setState('connected')
    return Promise.resolve()
  }

  close(): void {
    this.setState('idle')
  }

  getState(): RelayTransportState {
    return this.state
  }

  send(message: RelayClientMessage, target: RelayTarget): boolean {
    if (this.state !== 'connected') return false
    this.sent.push({ message, target })
    return true
  }

  sendControl(frame: RelayControlRequest): boolean {
    if (this.state !== 'connected') return false
    this.control.push(frame)
    return true
  }

  setState(state: RelayTransportState, detail?: string): void {
    this.state = state
    this.events?.onStateChange(state, detail)
  }

  deliver(message: RelayServerMessage, peer = PI_PUBKEY): void {
    this.events?.onMessage(message, { peer, room: '' })
  }

  get lastSent(): { message: RelayClientMessage; target: RelayTarget } | undefined {
    return this.sent[this.sent.length - 1]
  }
}

const PAIRED = { pubkey: PI_PUBKEY, agentName: 'macbook', pairedAt: '2026-10-18T00:00:00.000Z' }
const ROOM = { room_id: '9NsvFIsyNlTH', name: 'macbook', cwd: '/Users/alandtse/open-shaders' }

function manager(
  transport: ScriptedTransport,
  overrides: Partial<{ initialAgent: typeof PAIRED | null; onPaired: (agent: typeof PAIRED) => void }> = {},
) {
  return new RelaySessionManager({
    transport,
    initialAgent: overrides.initialAgent === undefined ? PAIRED : overrides.initialAgent,
    onPaired: overrides.onPaired,
    requestTimeoutMs: 200,
  })
}

test('pairing sends the token to the Pi and persists the agent only after pair_ok', async () => {
  const transport = new ScriptedTransport()
  const saved: unknown[] = []
  const subject = manager(transport, { initialAgent: null, onPaired: (agent) => void saved.push(agent) })

  const pairing = subject.pair({ token: 'onetimetoken', targetPubkey: PI_PUBKEY, agentName: 'macbook', roomId: 'room1' })
  await new Promise((resolve) => setImmediate(resolve))

  const sent = transport.lastSent
  assert.ok(sent)
  assert.equal(sent.message.type, 'pair_request')
  assert.equal((sent.message as { token: string }).token, 'onetimetoken')
  assert.equal(sent.target.peer, PI_PUBKEY)
  assert.equal(sent.target.room, 'room1')
  assert.equal(saved.length, 0, 'nothing is saved before the Pi agrees')

  const id = (sent.message as { id: string }).id
  transport.deliver({ type: 'pair_ok', in_reply_to: id, session_name: 'macbook' })

  const agent = await pairing
  assert.equal(agent.pubkey, PI_PUBKEY)
  assert.equal(saved.length, 1)
  assert.equal(subject.getState().status, 'paired')
})

test('a silently dropped pairing attempt blames the relay URL, not the link', async () => {
  // Two machines on different relays look like an expired link: the relay
  // never had the peer, so it drops the frame instead of replying and all we
  // see is a timeout. Point at the relay.
  const subject = manager(new ScriptedTransport())

  await assert.rejects(
    () =>
      subject.pair({ token: 'abc12345', targetPubkey: PI_PUBKEY, agentName: 'macbook', roomId: null }),
    /both machines use the same relay URL/,
  )
})

test('a rejected pairing surfaces the Pi error and leaves the desktop unpaired', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport, { initialAgent: null })

  const pairing = subject.pair({ token: 'expiredtoken', targetPubkey: PI_PUBKEY, agentName: 'macbook', roomId: null })
  await new Promise((resolve) => setImmediate(resolve))
  const id = (transport.lastSent?.message as { id: string }).id
  transport.deliver({ type: 'pair_error', in_reply_to: id, code: 'bad_token', message: 'token expired' })

  await assert.rejects(() => pairing, /token expired/)
  assert.equal(subject.getState().status, 'error')
  assert.equal(subject.getState().agent, null)
})

test('a reply naming an unknown request id is not consumed as the answer', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)

  const sync = subject.syncSession()
  await new Promise((resolve) => setImmediate(resolve))
  transport.deliver({ type: 'session_history', in_reply_to: 'not-our-id', events: [] })

  await assert.rejects(() => sync, /did not answer within 200ms/)
})

test('a reply from a peer other than the paired Pi is ignored entirely', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  const seen: unknown[] = []
  subject.on('message', (message) => seen.push(message))

  const sync = subject.syncSession()
  await new Promise((resolve) => setImmediate(resolve))
  const id = (transport.lastSent?.message as { id: string }).id

  transport.deliver({ type: 'session_history', in_reply_to: id, events: [{ role: 'user' }] }, OTHER_PUBKEY)
  await assert.rejects(() => sync, /did not answer within 200ms/)
  assert.equal(seen.length, 0, 'foreign traffic must not even be surfaced as an event')
})

test('the session transcript resolves the pending sync', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)

  const sync = subject.syncSession()
  await new Promise((resolve) => setImmediate(resolve))
  const id = (transport.lastSent?.message as { id: string }).id
  transport.deliver({ type: 'session_history', in_reply_to: id, events: [{ role: 'user', content: 'hi' }], eos: true })

  const { events } = await sync
  assert.equal(events.type, 'session_history')
  assert.equal(events.events.length, 1)
})

test('a roster push populates the room list', () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  transport.deliver({
    type: 'rooms',
    peer: PI_PUBKEY,
    rooms: [{ cwd: '/Users/a/project', name: 'project', room_id: 'abc' }],
  } as never)
  assert.equal(subject.getState().rooms.length, 1)
  assert.equal(subject.getState().rooms[0].cwd, '/Users/a/project')
})

test('connecting subscribes to the paired Pi roster so pushes arrive at all', async () => {
  // The relay only pushes `rooms` to subscribers, and drops subscriptions on
  // disconnect, so a missing subscribe leaves the room list permanently empty.
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()

  assert.deepEqual(transport.control, [{ type: 'subscribe_rooms', peers: [PI_PUBKEY] }])

  transport.setState('error', 'link dropped')
  transport.setState('connected')
  assert.equal(transport.control.length, 2, 'a reconnect must re-subscribe')
})

test('listing rooms asks the relay and waits for the roster reply', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()
  transport.control.length = 0

  const listing = subject.listRooms()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(transport.control, [{ type: 'rooms_check', peers: [PI_PUBKEY] }])
  assert.equal(transport.sent.length, 0, 'a ping answers with pong, which carries no roster')

  // The roster arrives as its own `rooms` frame; without it the call must not
  // resolve, which is the bug this covers: the panel used to show a stale list.
  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [ROOM] } as never)

  assert.deepEqual(await listing, [ROOM])
})

test('listing rooms fails loudly when the Paired Pi never answers', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()

  await assert.rejects(() => subject.listRooms(), /did not report its sessions/)
})

test('every action refuses to run before pairing', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport, { initialAgent: null })

  await assert.rejects(() => subject.syncSession(), /not paired/)
  await assert.rejects(() => subject.sendPrompt('hi'), /not paired/)
  await assert.rejects(() => subject.cancel(), /not paired/)
})

test('a prompt is sent to the paired Pi with a fresh correlation id', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()

  await subject.sendPrompt('refactor the parser')
  const sent = transport.lastSent
  assert.ok(sent)
  assert.equal(sent.message.type, 'user_message')
  assert.equal((sent.message as { text: string }).text, 'refactor the parser')
  assert.equal(sent.target.peer, PI_PUBKEY)
  assert.match((sent.message as { id: string }).id, /^desktop-/)
})

test('reconnecting keeps the paired status instead of dropping to connected', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()

  transport.setState('error', 'link dropped')
  assert.equal(subject.getState().status, 'error')

  transport.setState('connected')
  assert.equal(subject.getState().status, 'paired')
})
