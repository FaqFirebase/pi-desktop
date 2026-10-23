import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RelaySessionManager } from './relay-session-manager'
import type { RelayTarget, RelayTransport, RelayTransportEvents, RelayTransportState } from './relay-transport'
import type { RelayClientMessage, RelayControlRequest, RelayInboundMessage } from '../../shared/relay-protocol'
import type { PairedRelayAgent } from '../../shared/ipc-contracts'

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

  deliver(message: RelayInboundMessage, peer = PI_PUBKEY): void {
    this.events?.onMessage(message, { peer, room: '' })
  }

  get lastSent(): { message: RelayClientMessage; target: RelayTarget } | undefined {
    return this.sent[this.sent.length - 1]
  }
}

const PAIRED: PairedRelayAgent = { pubkey: PI_PUBKEY, agentName: 'macbook', roomId: 'room-abc', pairedAt: '2026-10-18T00:00:00.000Z' }
const ROOM = { room_id: '9NsvFIsyNlTH', name: 'macbook', cwd: '/Users/alandtse/open-shaders' }

function manager(
  transport: ScriptedTransport,
  overrides: Partial<{
    initialAgent: typeof PAIRED | null
    onPaired: (agent: typeof PAIRED) => void
    onAdopted: (agent: typeof PAIRED) => void
  }> = {},
) {
  return new RelaySessionManager({
    transport,
    initialAgent: overrides.initialAgent === undefined ? PAIRED : overrides.initialAgent,
    onPaired: overrides.onPaired,
    onAdopted: overrides.onAdopted,
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

  assert.deepEqual(transport.control, [
    { type: 'subscribe_rooms', peers: [PI_PUBKEY] },
    // A subscription only registers interest; the relay pushes nothing until a
    // session starts or stops, so the current roster must be asked for too.
    { type: 'rooms_check', peers: [PI_PUBKEY] },
  ])

  transport.setState('error', 'link dropped')
  transport.setState('connected')
  assert.equal(transport.control.length, 4, 'a reconnect must re-subscribe and re-check')
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

test('a roster with exactly one room replaces a stale stored room', async () => {
  // A Pi restart or a closed session leaves an id the relay silently drops.
  // With one room advertised there is no ambiguity about which to use.
  const transport = new ScriptedTransport()
  const saved: PairedRelayAgent[] = []
  const subject = manager(transport, { onAdopted: (agent) => void saved.push(agent) })
  await subject.connect()

  // PAIRED carries room-abc; the Pi now advertises a different room.
  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [ROOM] } as never)

  assert.equal(subject.getState().agent?.roomId, ROOM.room_id)
  assert.equal(saved.at(-1)?.roomId, ROOM.room_id, 'the repaired room must be persisted')
})

test('a roster with several rooms never guesses which one to drive', async () => {
  const transport = new ScriptedTransport()
  const saved: PairedRelayAgent[] = []
  const subject = manager(transport, { onAdopted: (agent) => void saved.push(agent) })
  await subject.connect()

  const other = { ...ROOM, room_id: 'room-other', name: 'other' }
  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [ROOM, other] } as never)

  assert.equal(subject.getState().agent?.roomId, 'room-abc', 'the stored choice must survive')
  assert.equal(saved.length, 0, 'nothing may be persisted without a user choice')
})

test('selecting a room addresses that room and persists the choice', async () => {
  const transport = new ScriptedTransport()
  const saved: PairedRelayAgent[] = []
  const subject = manager(transport, { onPaired: (agent) => void saved.push(agent) })
  await subject.connect()

  // Only an advertised room may be selected: the relay would drop anything else.
  await assert.rejects(() => subject.selectRoom('room-not-open'), /no longer open/)

  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [ROOM] } as never)
  const selected = await subject.selectRoom(ROOM.room_id)

  assert.equal(selected.roomId, ROOM.room_id)
  assert.equal(subject.getState().agent?.roomId, ROOM.room_id)
  assert.equal(saved.at(-1)?.roomId, ROOM.room_id)

  // Frames must now be addressed to the chosen room, not just the peer.
  transport.sent.length = 0
  // No reply is delivered, so this rejects on its own timer: swallow it here or
  // it surfaces as asynchronous activity after the test ends.
  void subject.syncSession().catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(transport.sent.at(-1)?.target.room, ROOM.room_id)
})

test('every action refuses to run before pairing', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport, { initialAgent: null })

  await assert.rejects(() => subject.syncSession(), /not paired/)
  await assert.rejects(() => subject.sendPrompt('hi'), /not paired/)
  await assert.rejects(() => subject.cancel(), /not paired/)
  await assert.rejects(() => subject.respondExtensionUi('req-1', { value: 'x' }), /not paired/)
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

test('listRooms answers from a roster that already arrived instead of asking again', async () => {
  // The relay suppresses a second identical roster per connection, so asking
  // again after the connect-time reply landed would wait for a frame it has
  // already decided not to send — the 15s stall seen in the app.
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()
  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [ROOM] } )

  const rooms = await subject.listRooms()
  assert.equal(rooms.length, 1, 'the roster that already arrived is the answer')
  assert.equal(transport.control.filter((frame) => frame.type === 'rooms_check').length, 1, 'no redundant check')
})

test('a dropped connection discards rosters recorded for the old one', async () => {
  // Subscriptions and their snapshots belong to the socket, so a reply recorded
  // before a drop must not satisfy a later listRooms with a stale snapshot.
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()
  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [ROOM] } )

  // Drop, then come back with a fresh socket that will never answer.
  transport.setState('idle')
  transport.setState('connected')
  const before = transport.control.filter((frame) => frame.type === 'rooms_check').length
  await assert.rejects(() => subject.listRooms(), /did not report its sessions/)
  assert.ok(
    transport.control.filter((frame) => frame.type === 'rooms_check').length > before,
    'the new connection must ask again rather than reuse the old snapshot',
  )
})

test('a session that opens after the initial roster is added to the list', async () => {
  // The relay pushes one `room_announced` per session instead of a new roster, so
  // without folding it in the list would only ever change on reconnect.
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()
  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [] })

  transport.deliver({ type: 'room_announced', peer: PI_PUBKEY, ...ROOM })

  const rooms = await subject.listRooms()
  assert.equal(rooms.length, 1)
  assert.equal(rooms[0]?.room_id, ROOM.room_id)
})

test('a session that ends is removed from the list', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()
  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [ROOM] })

  transport.deliver({ type: 'room_ended', peer: PI_PUBKEY, room_id: ROOM.room_id })

  const rooms = await subject.listRooms()
  assert.equal(rooms.length, 0)
})

test('a meta push updates the session it names and is ignored for unknown ones', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()
  transport.deliver({ type: 'rooms', peer: PI_PUBKEY, rooms: [ROOM] })

  transport.deliver({ type: 'room_meta_updated', peer: PI_PUBKEY, room_id: ROOM.room_id, meta: { working: true } })
  transport.deliver({ type: 'room_meta_updated', peer: PI_PUBKEY, room_id: 'not-a-known-room', meta: { working: true } })

  const rooms = await subject.listRooms()
  assert.equal(rooms.length, 1, 'an unknown room must not be invented')
  assert.equal(rooms[0]?.working, true)
})

test('an interactive answer reuses the request id the Pi is blocked on', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()

  await subject.respondExtensionUi('ext-42', { value: 'yes' })
  const sent = transport.lastSent
  assert.ok(sent)
  // The id is the Pi's, not one of ours: it correlates the answer with the
  // prompt, and a fresh id would be dropped and strand the turn until its TTL.
  assert.equal((sent.message as { id: string }).id, 'ext-42')
  assert.equal(sent.message.type, 'extension_ui_response')
  assert.equal((sent.message as { value: string }).value, 'yes')
  assert.equal(sent.target.peer, PI_PUBKEY)
})

test('a cancelled interactive answer says cancelled instead of sending an empty value', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()

  await subject.respondExtensionUi(' ext-7 ', { cancelled: true })
  const sent = transport.lastSent
  assert.ok(sent)
  // Surrounding whitespace is trimmed: the id must match byte-for-byte.
  assert.equal((sent.message as { id: string }).id, 'ext-7')
  assert.equal((sent.message as { cancelled: boolean }).cancelled, true)
  assert.equal((sent.message as { value?: string }).value, undefined)
})

test('an interactive answer without a request id is refused rather than sent', async () => {
  const transport = new ScriptedTransport()
  const subject = manager(transport)
  await subject.connect()

  await assert.rejects(() => subject.respondExtensionUi('   ', { value: 'x' }), /request id/)
  assert.equal(transport.lastSent, undefined)
})
