import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STALL_AFTER_MS, turnActivity } from './turn-activity'

const STARTED_AT = 1_000_000
const SECOND_MS = 1_000

test('turnActivity measures the time since the turn started and since the last event', () => {
  const now = STARTED_AT + 72 * SECOND_MS
  const activity = turnActivity({ now, startedAt: STARTED_AT, lastEventAt: now - 5 * SECOND_MS, toolRunning: false })
  assert.equal(activity.elapsedMs, 72 * SECOND_MS)
  assert.equal(activity.silentMs, 5 * SECOND_MS)
  assert.equal(activity.stalled, false)
})

test('a turn is stalled once no event came for STALL_AFTER_MS and no tool runs', () => {
  const lastEventAt = STARTED_AT
  const before = turnActivity({ now: lastEventAt + STALL_AFTER_MS - 1, startedAt: STARTED_AT, lastEventAt, toolRunning: false })
  assert.equal(before.stalled, false)
  const at = turnActivity({ now: lastEventAt + STALL_AFTER_MS, startedAt: STARTED_AT, lastEventAt, toolRunning: false })
  assert.equal(at.stalled, true)
})

test('a running tool is never stalled: a long command sends no events while it works', () => {
  const activity = turnActivity({ now: STARTED_AT + 10 * STALL_AFTER_MS, startedAt: STARTED_AT, lastEventAt: STARTED_AT, toolRunning: true })
  assert.equal(activity.stalled, false)
})

test('a clock that steps back reports no negative time', () => {
  const activity = turnActivity({ now: STARTED_AT - SECOND_MS, startedAt: STARTED_AT, lastEventAt: STARTED_AT, toolRunning: false })
  assert.equal(activity.elapsedMs, 0)
  assert.equal(activity.silentMs, 0)
})
