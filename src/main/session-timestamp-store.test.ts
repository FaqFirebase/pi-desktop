import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureGuiDataDir, getGuiDataPath } from './app-data-paths'
import { SessionTimestampStore } from './session-timestamp-store'

const TEST_FILE_NAME = 'test-sessions.json'
const FIRST_TIME = 100
const SECOND_TIME = 200
const KEPT_TIME = 5

async function freshDir(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-timestamps-'))
  configureGuiDataDir(dir)
}

test('add returns true once and keeps the first timestamp', async () => {
  await freshDir()
  const times = [FIRST_TIME, SECOND_TIME]
  const store = new SessionTimestampStore(TEST_FILE_NAME, () => times.shift() ?? SECOND_TIME)
  assert.equal(await store.add('a'), true)
  assert.equal(await store.add('a'), false)
  assert.deepEqual(await store.getAll(), { a: FIRST_TIME })
})

test('remove returns whether an entry was removed', async () => {
  await freshDir()
  const store = new SessionTimestampStore(TEST_FILE_NAME)
  await store.add('a')
  assert.equal(await store.remove('a'), true)
  assert.equal(await store.remove('a'), false)
  assert.equal(await store.has('a'), false)
})

test('entries persist across instances', async () => {
  await freshDir()
  await new SessionTimestampStore(TEST_FILE_NAME).add('b')
  const reloaded = new SessionTimestampStore(TEST_FILE_NAME)
  assert.deepEqual(Object.keys(await reloaded.getAll()), ['b'])
})

test('load drops non-numeric and non-object content', async () => {
  await freshDir()
  const path = getGuiDataPath(TEST_FILE_NAME)
  await writeFile(path, JSON.stringify({ ok: KEPT_TIME, bad: 'x', nan: null }), 'utf-8')
  assert.deepEqual(await new SessionTimestampStore(TEST_FILE_NAME).getAll(), { ok: KEPT_TIME })
  await writeFile(path, '[1,2]', 'utf-8')
  assert.deepEqual(await new SessionTimestampStore(TEST_FILE_NAME).getAll(), {})
  await writeFile(path, 'not json', 'utf-8')
  assert.deepEqual(await new SessionTimestampStore(TEST_FILE_NAME).getAll(), {})
})

test('getAll returns a copy', async () => {
  await freshDir()
  const store = new SessionTimestampStore(TEST_FILE_NAME)
  await store.add('a')
  const first = await store.getAll()
  delete first.a
  assert.deepEqual(Object.keys(await store.getAll()), ['a'])
})
