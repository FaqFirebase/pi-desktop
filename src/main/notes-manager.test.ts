import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureGuiDataDir } from './app-data-paths'
import { NotesManager, NoteNotFoundError, NoteValidationError } from './notes-manager'

async function freshManager(): Promise<NotesManager> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-notes-'))
  configureGuiDataDir(dir)
  return new NotesManager()
}

test('create normalizes fields and defaults scope to global', async () => {
  const mgr = await freshManager()
  const note = await mgr.create({ title: '  Hi  ', body: ' body ', tags: ['#A', 'a', 'B'], scope: '' })
  assert.equal(note.title, 'Hi')
  assert.equal(note.body, 'body')
  assert.deepEqual(note.tags, ['a', 'b'])
  assert.equal(note.scope, 'global')
  assert.ok(note.id && note.createdAt && note.updatedAt)
})

test('create rejects empty title or body', async () => {
  const mgr = await freshManager()
  await assert.rejects(() => mgr.create({ title: '   ', body: 'x', tags: [], scope: 'global' }), NoteValidationError)
  await assert.rejects(() => mgr.create({ title: 'x', body: '   ', tags: [], scope: 'global' }), NoteValidationError)
})

test('update merges, revalidates, and bumps updatedAt', async () => {
  const mgr = await freshManager()
  const note = await mgr.create({ title: 'a', body: 'b', tags: [], scope: 'global' })
  const updated = await mgr.update(note.id, { title: 'renamed' })
  assert.equal(updated.title, 'renamed')
  assert.equal(updated.body, 'b')
  assert.ok(updated.updatedAt >= note.updatedAt)
  await assert.rejects(() => mgr.update('missing-id', { title: 'x' }), NoteNotFoundError)
})

test('remove deletes and rejects unknown id', async () => {
  const mgr = await freshManager()
  const note = await mgr.create({ title: 'a', body: 'b', tags: [], scope: 'global' })
  await mgr.remove(note.id)
  assert.deepEqual(await mgr.list(), [])
  await assert.rejects(() => mgr.remove(note.id), NoteNotFoundError)
})

test('reassignToGlobal moves workspace-scoped notes to global', async () => {
  const mgr = await freshManager()
  await mgr.create({ title: 'ws', body: 'b', tags: [], scope: 'ws-1' })
  await mgr.create({ title: 'keep', body: 'b', tags: [], scope: 'ws-2' })
  await mgr.reassignToGlobal('ws-1')
  const notes = await mgr.list()
  assert.equal(notes.find((n) => n.title === 'ws')!.scope, 'global')
  assert.equal(notes.find((n) => n.title === 'keep')!.scope, 'ws-2')
})

test('notes persist across manager instances', async () => {
  const mgr = await freshManager()
  await mgr.create({ title: 'persisted', body: 'b', tags: [], scope: 'global' })
  const reloaded = new NotesManager()
  assert.equal((await reloaded.list()).length, 1)
})
