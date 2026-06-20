import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureGuiDataDir } from './app-data-paths'
import { ArchivedSessionsManager } from './archived-sessions'

async function freshDir(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-archived-'))
  configureGuiDataDir(dir)
}

test('archive then isArchived reflects state', async () => {
  await freshDir()
  const mgr = new ArchivedSessionsManager()
  assert.equal(await mgr.isArchived('s1'), false)
  await mgr.archive('s1')
  assert.equal(await mgr.isArchived('s1'), true)
})

test('archive persists across manager instances', async () => {
  await freshDir()
  await new ArchivedSessionsManager().archive('s2')
  const reloaded = new ArchivedSessionsManager()
  assert.equal(await reloaded.isArchived('s2'), true)
  assert.deepEqual(Object.keys(await reloaded.getAll()), ['s2'])
})

test('unarchive and forget remove the entry', async () => {
  await freshDir()
  const mgr = new ArchivedSessionsManager()
  await mgr.archive('a')
  await mgr.archive('b')
  await mgr.unarchive('a')
  assert.equal(await mgr.isArchived('a'), false)
  assert.equal(await mgr.isArchived('b'), true)
  await mgr.forget('b')
  assert.deepEqual(await mgr.getAll(), {})
})

test('archive is idempotent and unarchive of absent is a no-op', async () => {
  await freshDir()
  const mgr = new ArchivedSessionsManager()
  await mgr.archive('x')
  const first = (await mgr.getAll()).x
  await mgr.archive('x')
  assert.equal((await mgr.getAll()).x, first, 'archive must not overwrite the timestamp')
  await mgr.unarchive('missing') // must not throw
})
