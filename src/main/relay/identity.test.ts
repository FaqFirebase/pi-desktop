import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublicKey, verify } from 'node:crypto'
import {
  ED25519_RAW_KEY_BYTES,
  generateRelayKeypair,
  isValidRelayKeypair,
  publicKeyBase64FromPrivate,
  signChallenge,
} from './identity'

/** Rebuilds a KeyObject from the raw 32-byte key the relay expects as a peer id. */
function rawPublicKeyToKeyObject(base64: string) {
  const raw = Buffer.from(base64, 'base64')
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

test('generateRelayKeypair yields a 32-byte public key in canonical base64', () => {
  const keypair = generateRelayKeypair()
  const raw = Buffer.from(keypair.publicKeyBase64, 'base64')
  assert.equal(raw.length, ED25519_RAW_KEY_BYTES)
  // Canonical base64 re-encodes to itself; base64url would not.
  assert.equal(raw.toString('base64'), keypair.publicKeyBase64)
})

test('each generated keypair is distinct', () => {
  const first = generateRelayKeypair()
  const second = generateRelayKeypair()
  assert.notEqual(first.publicKeyBase64, second.publicKeyBase64)
})

test('signChallenge produces a signature the relay can verify against the advertised key', () => {
  const keypair = generateRelayKeypair()
  const nonce = Buffer.from('a-relay-challenge-nonce').toString('base64')
  const signature = signChallenge(keypair, nonce)

  const publicKey = rawPublicKeyToKeyObject(keypair.publicKeyBase64)
  const verified = verify(null, Buffer.from(nonce, 'base64'), publicKey, Buffer.from(signature, 'base64'))
  assert.equal(verified, true)
})

test('signChallenge signs the decoded nonce bytes, not its base64 text', () => {
  const keypair = generateRelayKeypair()
  const nonceBase64 = Buffer.from('nonce-bytes').toString('base64')
  const signature = signChallenge(keypair, nonceBase64)
  const publicKey = rawPublicKeyToKeyObject(keypair.publicKeyBase64)

  assert.equal(verify(null, Buffer.from('nonce-bytes'), publicKey, Buffer.from(signature, 'base64')), true)
  assert.equal(verify(null, Buffer.from(nonceBase64), publicKey, Buffer.from(signature, 'base64')), false)
})

test('publicKeyBase64FromPrivate recovers the advertised key', () => {
  const keypair = generateRelayKeypair()
  assert.equal(publicKeyBase64FromPrivate(keypair.privateKeyPem), keypair.publicKeyBase64)
})

test('isValidRelayKeypair accepts what generateRelayKeypair produced', () => {
  assert.equal(isValidRelayKeypair(generateRelayKeypair()), true)
})

test('isValidRelayKeypair rejects mismatched or malformed values', () => {
  const keypair = generateRelayKeypair()
  const other = generateRelayKeypair()

  assert.equal(isValidRelayKeypair({ ...keypair, publicKeyBase64: other.publicKeyBase64 }), false)
  assert.equal(isValidRelayKeypair({ ...keypair, privateKeyPem: 'not a pem' }), false)
  assert.equal(isValidRelayKeypair({ ...keypair, publicKeyBase64: Buffer.alloc(8).toString('base64') }), false)
  assert.equal(isValidRelayKeypair({ publicKeyBase64: keypair.publicKeyBase64 }), false)
  assert.equal(isValidRelayKeypair(null), false)
  assert.equal(isValidRelayKeypair(undefined), false)
  assert.equal(isValidRelayKeypair('keypair'), false)
})
