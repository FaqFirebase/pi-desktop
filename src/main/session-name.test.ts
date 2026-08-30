import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionInfoNameFromLine, latestSessionName, titleNameFromLine } from './session-name'

// The bounded file reading that feeds these parsers now lives in
// session-metadata.ts, so the head/tail and cache cases are covered by
// session-metadata.test.ts. What remains here is the line-level parsing.

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
    info('First title'),
    JSON.stringify({ type: 'message', message: { role: 'user' } }),
    info('Renamed later'),
  ]
  assert.equal(latestSessionName(lines), 'Renamed later')
})

test('latestSessionName is null when never named', () => {
  const lines = [
    JSON.stringify({ type: 'session', version: 3 }),
    JSON.stringify({ type: 'message', message: { role: 'user' } }),
  ]
  assert.equal(latestSessionName(lines), null)
})

test('latestSessionName reflects a clear after a name', () => {
  assert.equal(latestSessionName([info('Named'), info('')]), null)
})

// ─── OMP title slot ───────────────────────────────────────────────────────────

const titleRecord = (title: string): string =>
  JSON.stringify({ type: 'title', v: 1, title, updatedAt: '2026-08-24T20:05:17.256Z', pad: ' '.repeat(20) })

test('titleNameFromLine extracts a trimmed OMP title', () => {
  assert.equal(titleNameFromLine(titleRecord('  Fix AppImage  ')), 'Fix AppImage')
})

test('titleNameFromLine returns null for an empty title slot', () => {
  assert.equal(titleNameFromLine(titleRecord('')), null)
  assert.equal(titleNameFromLine(titleRecord('   ')), null)
})

test('titleNameFromLine ignores non-title lines', () => {
  assert.equal(titleNameFromLine(JSON.stringify({ type: 'session', version: 3 })), undefined)
  assert.equal(
    titleNameFromLine(JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'a "title" here' }] } })),
    undefined
  )
  assert.equal(titleNameFromLine(''), undefined)
  assert.equal(titleNameFromLine('not json'), undefined)
})
