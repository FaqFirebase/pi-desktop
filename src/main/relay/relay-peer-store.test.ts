import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateRelayKeypair } from './identity'
import { clearRelayTarget, readRelayPeer, relayPeerStorePath, writeRelayPeer, type RelayPeerRecord } from './relay-peer-store'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-store-'))
  dirs.push(dir)
  return dir
}

function record(target: RelayPeerRecord['target'] = null): RelayPeerRecord {
  return { keypair: generateRelayKeypair(), target }
}

test('readRelayPeer returns null when nothing has been written', async () => {
  const dir = await tempDir()
  assert.equal(await readRelayPeer(dir), null)
})

test('the record round-trips, keypair and target intact', async () => {
  const dir = await tempDir()
  const written = record({ pubkey: 'a'.repeat(43) + '=', agentName: 'macbook', roomId: 'abc123', pairedAt: '2026-10-18T00:00:00.000Z' })
  await writeRelayPeer(dir, written)

  const read = await readRelayPeer(dir)
  assert.ok(read)
  assert.deepEqual(read.keypair, written.keypair)
  assert.deepEqual(read.target, written.target)
})

test('the store is written outside settings.json, with the keypair under a version', async () => {
  const dir = await tempDir()
  await writeRelayPeer(dir, record())

  const raw = JSON.parse(await readFile(relayPeerStorePath(dir), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(typeof raw.keypair.privateKeyPem, 'string')
  assert.equal(relayPeerStorePath(dir).endsWith('relay-peer.json'), true)
})

test('a corrupt store is treated as not paired rather than trusted', async () => {
  const dir = await tempDir()
  await writeFile(relayPeerStorePath(dir), 'this is not json', 'utf8')
  assert.equal(await readRelayPeer(dir), null)
})

test('a keypair whose public half does not match its private key is rejected', async () => {
  const dir = await tempDir()
  const good = generateRelayKeypair()
  const other = generateRelayKeypair()
  await writeFile(
    relayPeerStorePath(dir),
    JSON.stringify({ version: 1, keypair: { ...good, publicKeyBase64: other.publicKeyBase64 }, target: null }),
    'utf8',
  )
  assert.equal(await readRelayPeer(dir), null)
})

test('an unknown store version is rejected, not migrated blindly', async () => {
  const dir = await tempDir()
  await writeFile(relayPeerStorePath(dir), JSON.stringify({ version: 99, keypair: generateRelayKeypair(), target: null }), 'utf8')
  assert.equal(await readRelayPeer(dir), null)
})

test('clearRelayTarget drops the pairing but keeps the same keypair', async () => {
  const dir = await tempDir()
  const written = record({ pubkey: 'b'.repeat(43) + '=', agentName: 'macbook', roomId: null, pairedAt: '2026-10-18T00:00:00.000Z' })
  await writeRelayPeer(dir, written)

  const cleared = await clearRelayTarget(dir, written)
  assert.equal(cleared.target, null)
  assert.deepEqual(cleared.keypair, written.keypair)

  const read = await readRelayPeer(dir)
  assert.ok(read)
  assert.equal(read.target, null)
  assert.equal(read.keypair.publicKeyBase64, written.keypair.publicKeyBase64)
})

test('the file is created with owner-only permissions on posix', async () => {
  if (process.platform === 'win32') return
  const dir = await tempDir()
  await writeRelayPeer(dir, record())
  const { stat } = await import('node:fs/promises')
  const mode = (await stat(relayPeerStorePath(dir))).mode & 0o777
  assert.equal(mode, 0o600)
})
