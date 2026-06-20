import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureGuiDataDir } from './app-data-paths'
import { SessionTagManager } from './session-tags'

async function freshManager(): Promise<SessionTagManager> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tags-'))
  configureGuiDataDir(dir)
  return new SessionTagManager()
}

test('setTags normalizes case, #, whitespace and dedupes', async () => {
  const mgr = await freshManager()
  await mgr.setTags('s1', ['  #Bug ', 'bug', 'FEATURE'])
  assert.deepEqual(await mgr.getTags('s1'), ['bug', 'feature'])
})

test('setTags with empty list clears the session', async () => {
  const mgr = await freshManager()
  await mgr.setTags('s1', ['x'])
  await mgr.setTags('s1', ['   ', '#'])
  assert.deepEqual(await mgr.getTags('s1'), [])
})

test('addTag is idempotent and rejects over-long tags', async () => {
  const mgr = await freshManager()
  await mgr.addTag('s1', 'alpha')
  await mgr.addTag('s1', 'alpha')
  assert.deepEqual(await mgr.getTags('s1'), ['alpha'])
  const tooLong = 'x'.repeat(40)
  await mgr.addTag('s1', tooLong)
  assert.deepEqual(await mgr.getTags('s1'), ['alpha'], 'over-length tag is ignored')
})

test('removeTag drops the tag and empties the session when last', async () => {
  const mgr = await freshManager()
  await mgr.setTags('s1', ['a', 'b'])
  await mgr.removeTag('s1', '#A') // normalization applies on remove too
  assert.deepEqual(await mgr.getTags('s1'), ['b'])
  await mgr.removeTag('s1', 'b')
  assert.deepEqual(await mgr.getAllTags(), {})
})

test('getSessionsWithTag and getAllUsedTags aggregate across sessions', async () => {
  const mgr = await freshManager()
  await mgr.setTags('s1', ['shared', 'one'])
  await mgr.setTags('s2', ['shared', 'two'])
  assert.deepEqual((await mgr.getSessionsWithTag('shared')).sort(), ['s1', 's2'])
  assert.deepEqual(await mgr.getAllUsedTags(), ['one', 'shared', 'two'])
})

test('tags persist across manager instances', async () => {
  const mgr = await freshManager()
  await mgr.setTags('s1', ['keep'])
  // Reuse the same configured dir with a new instance.
  const reloaded = new SessionTagManager()
  assert.deepEqual(await reloaded.getTags('s1'), ['keep'])
})
