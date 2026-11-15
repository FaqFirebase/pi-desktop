import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatImportIndex, chatImportKey } from './chat-import-index'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-chat-import-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('chatImportKey includes the engine', () => {
  assert.equal(chatImportKey('omp', 'codex', 'x'), 'omp:codex:x')
  assert.equal(chatImportKey('pi', 'claude-code', 'x'), 'pi:claude-code:x')
})

test('importedPath is null for an unknown key', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await new ChatImportIndex(join(dir, 'chat-imports.json')).importedPath('pi:codex:x'), null)
  })
})

test('record then importedPath returns the path while the file exists', async () => {
  await withTempDir(async (dir) => {
    const session = join(dir, 'session.jsonl')
    await writeFile(session, '{}\n')
    const index = new ChatImportIndex(join(dir, 'data', 'chat-imports.json'))
    await index.record('pi:codex:x', session)
    assert.equal(await index.importedPath('pi:codex:x'), session)
    const saved = JSON.parse(await readFile(join(dir, 'data', 'chat-imports.json'), 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.entries['pi:codex:x'].sessionPath, session)
    assert.equal(typeof saved.entries['pi:codex:x'].importedAt, 'number')
  })
})

test('importedPath is null after the session file is removed', async () => {
  await withTempDir(async (dir) => {
    const session = join(dir, 'session.jsonl')
    await writeFile(session, '{}\n')
    const index = new ChatImportIndex(join(dir, 'chat-imports.json'))
    await index.record('pi:codex:x', session)
    await rm(session)
    assert.equal(await index.importedPath('pi:codex:x'), null)
  })
})

test('record persists across instances', async () => {
  await withTempDir(async (dir) => {
    const session = join(dir, 'session.jsonl')
    await writeFile(session, '{}\n')
    const file = join(dir, 'chat-imports.json')
    await new ChatImportIndex(file).record('omp:claude-code:a', session)
    assert.equal(await new ChatImportIndex(file).importedPath('omp:claude-code:a'), session)
  })
})

test('a damaged index file reads as empty', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'chat-imports.json')
    await writeFile(file, '{"version":1,"entries":{"pi:codex:a":{"sessionPath":5},"pi:codex:b":null}}')
    const index = new ChatImportIndex(file)
    assert.equal(await index.importedPath('pi:codex:a'), null)
    await writeFile(file, 'not json')
    assert.equal(await new ChatImportIndex(file).importedPath('pi:codex:a'), null)
  })
})
