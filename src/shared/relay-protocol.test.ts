import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeEnvelope,
  encodeEnvelope,
  normalizeRelayUrl,
  parsePairingUri,
  toWebSocketUrl,
  type RelayClientMessage,
} from './relay-protocol'

const PUBKEY_BASE64URL = 'nJvBiqtqL1vZZNa0WpBynaj7EeNfq_g5fauzA516IcM'
const PUBKEY_BASE64 = 'nJvBiqtqL1vZZNa0WpBynaj7EeNfq/g5fauzA516IcM='

test('normalizeRelayUrl accepts http and https and trims trailing slashes', () => {
  assert.equal(normalizeRelayUrl('http://192.168.1.223:3000'), 'http://192.168.1.223:3000')
  assert.equal(normalizeRelayUrl('https://relay.example.com/'), 'https://relay.example.com')
  assert.equal(normalizeRelayUrl('  http://host:1234//  '), 'http://host:1234')
})

test('normalizeRelayUrl rejects schemes the relay client cannot dial', () => {
  assert.equal(normalizeRelayUrl('ws://192.168.1.223:3000'), null)
  assert.equal(normalizeRelayUrl('wss://relay.example.com'), null)
  assert.equal(normalizeRelayUrl('ftp://host'), null)
  assert.equal(normalizeRelayUrl('not a url'), null)
  assert.equal(normalizeRelayUrl(''), null)
})

test('toWebSocketUrl maps the HTTP scheme onto ws/wss', () => {
  assert.equal(toWebSocketUrl('http://192.168.1.223:3000'), 'ws://192.168.1.223:3000')
  assert.equal(toWebSocketUrl('https://relay.example.com'), 'wss://relay.example.com')
  assert.throws(() => toWebSocketUrl('ws://host'), /Unsupported relay URL/)
})

test('parsePairingUri reads the URI a desktop pastes instead of scanning', () => {
  const uri = `remotepi://pair?t=abcdefgh12345678&epk=${PUBKEY_BASE64URL}&n=desktop&rm=9NsvFIsyNlTH`
  const parsed = parsePairingUri(uri)
  assert.ok(parsed)
  assert.equal(parsed.token, 'abcdefgh12345678')
  assert.equal(parsed.targetPubkey, PUBKEY_BASE64)
  assert.equal(parsed.agentName, 'desktop')
  assert.equal(parsed.roomId, '9NsvFIsyNlTH')
})

test('parsePairingUri tolerates a missing room and name', () => {
  const parsed = parsePairingUri(`remotepi://pair?t=abcdefgh12345678&epk=${PUBKEY_BASE64URL}`)
  assert.ok(parsed)
  assert.equal(parsed.agentName, '')
  assert.equal(parsed.roomId, null)
})

test('parsePairingUri rejects malformed input without throwing', () => {
  assert.equal(parsePairingUri(''), null)
  assert.equal(parsePairingUri('https://example.com'), null)
  assert.equal(parsePairingUri('remotepi://pair?epk=' + PUBKEY_BASE64URL), null)
  assert.equal(parsePairingUri('remotepi://pair?t=short&epk=' + PUBKEY_BASE64URL), null)
  assert.equal(parsePairingUri('remotepi://pair?t=abcdefgh12345678'), null)
  assert.equal(parsePairingUri('remotepi://pair?t=abcdefgh12345678&epk=not-a-key'), null)
})

test('parsePairingUri rejects a key that is not 32 bytes', () => {
  const short = Buffer.from('too short').toString('base64url')
  assert.equal(parsePairingUri(`remotepi://pair?t=abcdefgh12345678&epk=${short}`), null)
})

test('encodeEnvelope round-trips through decodeEnvelope', () => {
  const message: RelayClientMessage = { type: 'session_sync', id: 'req-1' }
  const frame = encodeEnvelope(message, { peer: PUBKEY_BASE64, room: '9NsvFIsyNlTH' })
  const outer = JSON.parse(frame)
  assert.equal(outer.peer, PUBKEY_BASE64)
  assert.equal(outer.room, '9NsvFIsyNlTH')
  assert.equal(typeof outer.ct, 'string')

  const decoded = decodeEnvelope(JSON.stringify({
    peer: PUBKEY_BASE64,
    room: '9NsvFIsyNlTH',
    ct: Buffer.from(JSON.stringify({ type: 'session_history', events: [{ role: 'user' }], eos: true })).toString('base64'),
  }))
  assert.ok(decoded)
  assert.equal(decoded.peer, PUBKEY_BASE64)
  assert.equal(decoded.inner.type, 'session_history')
})

test('decodeEnvelope returns null for frames carrying no inner message', () => {
  assert.equal(decodeEnvelope('not json'), null)
  assert.equal(decodeEnvelope(JSON.stringify({ type: 'challenge', nonce: 'x' })), null)
  assert.equal(decodeEnvelope(JSON.stringify({ ct: Buffer.from('{"no":"type"}').toString('base64') })), null)
  assert.equal(decodeEnvelope(JSON.stringify({ ct: Buffer.from('not json').toString('base64') })), null)
})
