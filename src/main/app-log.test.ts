import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AppLog, MAX_LOG_BYTES, RECENT_LIMIT, describeLogDetail } from './app-log'
import type { AppLogEntry } from '../shared/ipc-contracts'

async function makeLogPath(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'app-log-'))
  return join(base, 'app-log.jsonl')
}

function entryLine(entry: AppLogEntry): string {
  return JSON.stringify(entry) + '\n'
}

test('records entries with described detail and returns them oldest first', async () => {
  const log = new AppLog({ logPath: await makeLogPath(), now: () => 1000 })
  log.error('pi', 'spawn failed', new Error('ENOENT: pi not found'))
  log.warn('git', 'status failed', { code: 128 })
  log.info('app', 'started')

  const recent = log.getRecent()
  assert.equal(recent.length, 3)
  assert.equal(recent[0].level, 'error')
  assert.equal(recent[0].scope, 'pi')
  assert.match(recent[0].detail ?? '', /ENOENT: pi not found/)
  assert.equal(recent[1].detail, '{"code":128}')
  assert.equal(recent[2].detail, undefined)
  assert.equal(recent[2].ts, 1000)
})

test('caps the in-memory ring at RECENT_LIMIT keeping the newest entries', async () => {
  const log = new AppLog({ logPath: await makeLogPath() })
  for (let i = 0; i < RECENT_LIMIT + 25; i++) {
    log.info('test', `message ${i}`)
  }
  const recent = log.getRecent()
  assert.equal(recent.length, RECENT_LIMIT)
  assert.equal(recent[0].message, 'message 25')
  assert.equal(recent[recent.length - 1].message, `message ${RECENT_LIMIT + 24}`)
})

test('flushSync persists pending entries as JSONL', async () => {
  const logPath = await makeLogPath()
  const log = new AppLog({ logPath })
  log.error('pi', 'pre-flight failed', 'binary missing')
  log.flushSync()

  const persisted = await log.readPersisted()
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].message, 'pre-flight failed')
  assert.equal(persisted[0].detail, 'binary missing')

  // A second flush with nothing pending must not duplicate entries.
  log.flushSync()
  assert.equal((await log.readPersisted()).length, 1)
})

test('debounced async flush writes without an explicit flushSync', async () => {
  const logPath = await makeLogPath()
  const log = new AppLog({ logPath, flushDelayMs: 10 })
  log.warn('git', 'diff failed')

  await new Promise((resolve) => setTimeout(resolve, 100))
  const persisted = await log.readPersisted()
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].message, 'diff failed')
})

test('seeds the ring from the existing file tail, skipping corrupt lines', async () => {
  const logPath = await makeLogPath()
  const prior: AppLogEntry = { ts: 1, level: 'error', scope: 'app', message: 'old crash' }
  const wrongShape = JSON.stringify({ ts: 'not-a-number', level: 'error' }) + '\n'
  await writeFile(logPath, entryLine(prior) + 'not json{\n' + wrongShape, 'utf-8')

  const log = new AppLog({ logPath })
  log.info('app', 'started')

  const recent = log.getRecent()
  assert.equal(recent.length, 2)
  assert.equal(recent[0].message, 'old crash')
  assert.equal(recent[1].message, 'started')
})

test('rotates the file to .1 when it exceeds the size cap', async () => {
  const logPath = await makeLogPath()
  const bigEntry: AppLogEntry = { ts: 1, level: 'info', scope: 'x', message: 'y'.repeat(1024) }
  const lines = entryLine(bigEntry).repeat(Math.ceil(MAX_LOG_BYTES / 1024) + 8)
  await writeFile(logPath, lines, 'utf-8')

  const log = new AppLog({ logPath })
  log.info('app', 'after rotation')
  log.flushSync()

  const rotated = await stat(`${logPath}.1`)
  assert.ok(rotated.size > MAX_LOG_BYTES)
  const fresh = await readFile(logPath, 'utf-8')
  const freshLines = fresh.trim().split('\n')
  assert.equal(freshLines.length, 1)
  assert.match(freshLines[0], /after rotation/)
})

test('describeLogDetail stringifies errors, objects, and passthrough strings', () => {
  assert.equal(describeLogDetail(undefined), undefined)
  assert.equal(describeLogDetail(null), undefined)
  assert.equal(describeLogDetail('plain'), 'plain')
  assert.match(describeLogDetail(new Error('boom')) ?? '', /boom/)
  assert.equal(describeLogDetail({ a: 1 }), '{"a":1}')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(describeLogDetail(circular), '[object Object]')
})
