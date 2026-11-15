import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectListedSessions } from './pinned-sessions'

const LIMIT = 2
const PIN_TIME = 1

function rows(ids: string[]): Array<{ sessionId: string }> {
  return ids.map((sessionId) => ({ sessionId }))
}

function ids(list: Array<{ sessionId: string }>): string[] {
  return list.map((row) => row.sessionId)
}

test('selectListedSessions returns the first rows when nothing is pinned', () => {
  assert.deepEqual(ids(selectListedSessions(rows(['a', 'b', 'c']), LIMIT, {})), ['a', 'b'])
})

test('selectListedSessions keeps pinned rows beyond the limit', () => {
  assert.deepEqual(ids(selectListedSessions(rows(['a', 'b', 'c', 'd']), LIMIT, { d: PIN_TIME })), ['a', 'b', 'd'])
})

test('selectListedSessions does not duplicate a pinned row inside the limit', () => {
  assert.deepEqual(ids(selectListedSessions(rows(['a', 'b', 'c']), LIMIT, { a: PIN_TIME })), ['a', 'b'])
})
