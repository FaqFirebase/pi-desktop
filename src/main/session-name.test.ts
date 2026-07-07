import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionInfoNameFromLine, latestSessionName } from './session-name'

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
