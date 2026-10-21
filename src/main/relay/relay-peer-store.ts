/**
 * On-disk state for the relay peer: our Ed25519 keypair and the Pi we paired with.
 *
 * Kept out of settings.json so the private key is never merged, migrated, or sent
 * over IPC.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appLog } from '../app-log'
import { isValidRelayKeypair, type RelayKeypair } from './identity'

export interface RelayPeerRecord {
  keypair: RelayKeypair
  /** The Pi we paired with; one desktop pairs with one relay room at a time. */
  target: {
    pubkey: string
    agentName: string
    roomId: string | null
    pairedAt: string
  } | null
}

const STORE_VERSION = 1
const STORE_FILENAME = 'relay-peer.json'

interface StoredShape extends RelayPeerRecord {
  version: number
}

/** Path of the store inside a userData directory. */
export function relayPeerStorePath(userDataDir: string): string {
  return join(userDataDir, STORE_FILENAME)
}

/**
 * Reads the peer record, treating anything unreadable as "not paired".
 *
 * A corrupt record is discarded rather than repaired: the only recovery is
 * re-pairing, and a half-trusted key is worse than none.
 */
export async function readRelayPeer(userDataDir: string): Promise<RelayPeerRecord | null> {
  const path = relayPeerStorePath(userDataDir)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    appLog.warn('relay', 'Stored relay peer file is not valid JSON; ignoring it')
    return null
  }
  const stored = parsed as Partial<StoredShape>
  if (stored.version !== STORE_VERSION) {
    appLog.warn('relay', 'Stored relay peer file has an unknown version; ignoring it', { version: stored.version })
    return null
  }
  if (!isValidRelayKeypair(stored.keypair)) {
    appLog.warn('relay', 'Stored relay keypair does not match its public key; ignoring it')
    return null
  }
  return { keypair: stored.keypair, target: stored.target ?? null }
}

/** Writes the record atomically, so a crash cannot leave half a keypair. */
export async function writeRelayPeer(userDataDir: string, record: RelayPeerRecord): Promise<void> {
  const path = relayPeerStorePath(userDataDir)
  await mkdir(dirname(path), { recursive: true })
  const payload: StoredShape = { version: STORE_VERSION, ...record }
  const temporary = `${path}.tmp`
  // 0600: the file holds a private key, so do not rely on the umask.
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/** Removes the pairing, keeping the keypair so a re-pair is not a new identity. */
export async function clearRelayTarget(userDataDir: string, record: RelayPeerRecord): Promise<RelayPeerRecord> {
  const next: RelayPeerRecord = { keypair: record.keypair, target: null }
  await writeRelayPeer(userDataDir, next)
  return next
}
