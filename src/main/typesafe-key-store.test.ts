import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { tmpdir } from 'os'
import { TypeSafeKeyStore, typeSafeKeyEnv } from './typesafe-key-store'

const OWNER_ONLY_MODE = 0o600
const PERMISSION_BITS = 0o777

async function tempKeyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-typesafe-key-'))
  return join(dir, 'typesafe-api-key')
}

test('no key is saved until the user saves one', async () => {
  const path = await tempKeyPath()
  assert.equal(new TypeSafeKeyStore(() => path).getSavedKey(), null)
})

test('a saved key is written to its own file and read back by a new store', async () => {
  const path = await tempKeyPath()
  const store = new TypeSafeKeyStore(() => path)
  assert.equal(await store.save('  ts_live_abc  '), true)
  assert.equal(store.getSavedKey(), 'ts_live_abc')
  assert.equal(await readFile(path, 'utf8'), 'ts_live_abc\n')
  assert.equal(new TypeSafeKeyStore(() => path).getSavedKey(), 'ts_live_abc')
})

test('the key file is readable by its owner only', { skip: process.platform === 'win32' }, async () => {
  const path = await tempKeyPath()
  await new TypeSafeKeyStore(() => path).save('ts_live_abc')
  assert.equal((await stat(path)).mode & PERMISSION_BITS, OWNER_ONLY_MODE)
})

test('saving again replaces the key and keeps the file owner-only', { skip: process.platform === 'win32' }, async () => {
  const path = await tempKeyPath()
  const store = new TypeSafeKeyStore(() => path)
  await store.save('ts_live_first')
  await store.save('ts_live_second')
  assert.equal(new TypeSafeKeyStore(() => path).getSavedKey(), 'ts_live_second')
  assert.equal((await stat(path)).mode & PERMISSION_BITS, OWNER_ONLY_MODE)
})

test('an invalid key is refused and nothing is written', async () => {
  const path = await tempKeyPath()
  const store = new TypeSafeKeyStore(() => path)
  assert.equal(await store.save('has space'), false)
  assert.equal(existsSync(path), false)
  assert.equal(store.getSavedKey(), null)
})

test('a save that fails leaves no stray copy of the key', async () => {
  const path = await tempKeyPath()
  // A non-empty folder where the key file belongs makes the final rename fail.
  await mkdir(join(path, 'blocker'), { recursive: true })
  const store = new TypeSafeKeyStore(() => path)
  await assert.rejects(store.save('ts_live_abc'))
  assert.deepEqual(await readdir(dirname(path)), [basename(path)])
  assert.equal(store.getSavedKey(), null)
})

test('clearing removes the file and the cached key', async () => {
  const path = await tempKeyPath()
  const store = new TypeSafeKeyStore(() => path)
  await store.save('ts_live_abc')
  await store.clear()
  assert.equal(existsSync(path), false)
  assert.equal(store.getSavedKey(), null)
})

test('clearing when no key is saved succeeds', async () => {
  const path = await tempKeyPath()
  const store = new TypeSafeKeyStore(() => path)
  await store.clear()
  assert.equal(store.getSavedKey(), null)
})

test('a file that does not hold a valid key reads as no key', async () => {
  const path = await tempKeyPath()
  await writeFile(path, 'not a key\n')
  assert.equal(new TypeSafeKeyStore(() => path).getSavedKey(), null)
})

test('the saved key is passed to the agent when the environment has none', () => {
  assert.deepEqual(typeSafeKeyEnv('ts_live_abc', {}), { TYPESAFE_API_KEY: 'ts_live_abc' })
  assert.deepEqual(typeSafeKeyEnv('ts_live_abc', { TYPESAFE_API_KEY: '' }), { TYPESAFE_API_KEY: 'ts_live_abc' })
})

test('a key already in the environment wins over the saved key', () => {
  assert.deepEqual(typeSafeKeyEnv('ts_live_abc', { TYPESAFE_API_KEY: 'from_shell' }), {})
})

test('nothing is added when no key is saved', () => {
  assert.deepEqual(typeSafeKeyEnv(null, {}), {})
})
