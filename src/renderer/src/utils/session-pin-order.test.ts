import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderSessionsPinnedFirst } from './session-pin-order'

interface Row {
  sessionId: string
  lastModified: number
}

// lastModified per id: b is newest, then c, then a; d is the newest of all.
const ROWS: Row[] = [
  { sessionId: 'a', lastModified: 1 },
  { sessionId: 'b', lastModified: 3 },
  { sessionId: 'c', lastModified: 2 },
  { sessionId: 'd', lastModified: 4 },
]
const UNPINNED_ROWS = ROWS.slice(0, 3)
const EARLY_PIN = 10
const LATE_PIN = 20
const LATER_PIN = 30

function ids(rows: readonly Row[]): string[] {
  return rows.map((row) => row.sessionId)
}

test('unpinned rows sort newest first', () => {
  assert.deepEqual(ids(orderSessionsPinnedFirst(UNPINNED_ROWS, {})), ['b', 'c', 'a'])
})

test('pinned rows lead in pin order', () => {
  assert.deepEqual(ids(orderSessionsPinnedFirst(ROWS, { a: LATE_PIN, c: EARLY_PIN })), ['c', 'a', 'd', 'b'])
})

test('re-pinning moves a row to the end of the pinned block', () => {
  assert.deepEqual(ids(orderSessionsPinnedFirst(ROWS, { a: EARLY_PIN, c: LATER_PIN })), ['a', 'c', 'd', 'b'])
})

test('the input is not mutated', () => {
  const input = [...ROWS]
  orderSessionsPinnedFirst(input, { c: EARLY_PIN })
  assert.deepEqual(ids(input), ids(ROWS))
})
