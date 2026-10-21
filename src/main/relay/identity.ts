/**
 * Ed25519 identity for the desktop's relay peer.
 *
 * The public half IS the peer id a Pi stores in its `peers.json`, so replacing
 * the keypair requires re-pairing every Pi.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as signBytes, type KeyObject } from 'node:crypto'

export interface RelayKeypair {
  /** base64 (canonical, not url-safe) of the raw 32-byte public key. */
  publicKeyBase64: string
  privateKeyPem: string
}

/** SPKI DER for an Ed25519 key is a 12-byte header followed by the 32-byte key. */
const ED25519_SPKI_PREFIX_BYTES = 12
const ED25519_RAW_KEY_BYTES = 32

export function generateRelayKeypair(): RelayKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyBase64: rawPublicKeyBase64(publicKey),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

function rawPublicKeyBase64(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' })
  return der.subarray(der.length - ED25519_RAW_KEY_BYTES).toString('base64')
}

/**
 * Signs the relay's challenge nonce.
 *
 * Must use the same keypair whose public half was sent in `hello`: the relay
 * accepts the first signature returned for a nonce.
 */
export function signChallenge(keypair: RelayKeypair, nonceBase64: string): string {
  const privateKey = createPrivateKey(keypair.privateKeyPem)
  const nonce = Buffer.from(nonceBase64, 'base64')
  return signBytes(null, nonce, privateKey).toString('base64')
}

/** Re-derives the public half, to detect a stored pair that no longer matches. */
export function publicKeyBase64FromPrivate(privateKeyPem: string): string {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem))
  return rawPublicKeyBase64(publicKey)
}

export function isValidRelayKeypair(value: unknown): value is RelayKeypair {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RelayKeypair>
  if (typeof candidate.publicKeyBase64 !== 'string' || typeof candidate.privateKeyPem !== 'string') {
    return false
  }
  const raw = Buffer.from(candidate.publicKeyBase64, 'base64')
  if (raw.length !== ED25519_RAW_KEY_BYTES) return false
  try {
    return publicKeyBase64FromPrivate(candidate.privateKeyPem) === candidate.publicKeyBase64
  } catch {
    return false
  }
}

export { ED25519_RAW_KEY_BYTES, ED25519_SPKI_PREFIX_BYTES }
