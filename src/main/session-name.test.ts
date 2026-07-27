import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  sessionInfoNameFromLine,
  latestSessionName,
  readSessionName,
  readSessionNameCached,
  clearSessionNameCache,
} from './session-name'

const info = (name: string): string =>
  JSON.stringify({ type: 'session_info', id: 'a1', parentId: 'b2', timestamp: '2026-07-04T00:00:00Z', name })

test('sessionInfoNameFromLine extracts a trimmed name', () => {
  assert.equal(sessionInfoNameFromLine(info('  Refactor auth  ')), 'Refactor auth')
})

test('sessionInfoNameFromLine returns null for a cleared (empty) name', () => {
  assert.equal(sessionInfoNameFromLine(info('   ')), null)
})

test('sessionInfoNameFromLine ignores non-session_info lines', () => {
  assert.equal(sessionInfoNameFromLine(JSON.stringify({ type: 'message', message: {} })), undefined)
  assert.equal(sessionInfoNameFromLine(JSON.stringify({ type: 'session', version: 3 })), undefined)
  assert.equal(sessionInfoNameFromLine(''), undefined)
  assert.equal(sessionInfoNameFromLine('not json'), undefined)
})

test('latestSessionName returns the last session_info name', () => {
  const lines = [
    JSON.stringify({ type: 'session', version: 3 }),
    JSON.stringify({ type: 'message' }),
    info('First title'),
    JSON.stringify({ type: 'message' }),
    info('Renamed later'),
  ]
  assert.equal(latestSessionName(lines), 'Renamed later')
})

test('latestSessionName is null when never named', () => {
  const lines = [
    JSON.stringify({ type: 'session', version: 3 }),
    JSON.stringify({ type: 'message' }),
  ]
  assert.equal(latestSessionName(lines), null)
})

test('latestSessionName reflects a clear after a name', () => {
  assert.equal(latestSessionName([info('Named'), info('')]), null)
})

test('readSessionName prefers a late rename in the tail over an early title', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-name-'))
  try {
    const file = join(dir, 'session.jsonl')
    // ~400KB body so head+tail paths both run; rename only in the tail.
    const pad = 'x'.repeat(400 * 1024)
    const body = [
      info('Early title'),
      JSON.stringify({ type: 'message', message: { role: 'user', content: pad } }),
      info('Renamed in tail'),
    ].join('\n')
    await writeFile(file, body, 'utf8')
    assert.equal(await readSessionName(file), 'Renamed in tail')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readSessionNameCached returns the same name for the same mtime', async () => {
  clearSessionNameCache()
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-name-cache-'))
  try {
    const file = join(dir, 'session.jsonl')
    await writeFile(file, info('Cached name') + '\n', 'utf8')
    const first = await readSessionNameCached(file, 1000)
    const second = await readSessionNameCached(file, 1000)
    assert.equal(first, 'Cached name')
    assert.equal(second, 'Cached name')
    // Different mtime forces a re-read path (still same file content here).
    const third = await readSessionNameCached(file, 2000)
    assert.equal(third, 'Cached name')
  } finally {
    clearSessionNameCache()
    await rm(dir, { recursive: true, force: true })
  }
})
