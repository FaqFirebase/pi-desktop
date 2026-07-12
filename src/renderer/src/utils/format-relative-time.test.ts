import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRelativeTime } from './format-relative-time'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// A fixed "now" so the absolute-date fallback is deterministic.
const NOW = Date.parse('2026-07-12T12:00:00Z')
const ago = (ms: number): string => formatRelativeTime(NOW - ms, NOW)

test('sub-45s reads "just now" (incl. clock-skew future timestamps)', () => {
  assert.equal(ago(0), 'just now')
  assert.equal(ago(44 * SECOND), 'just now')
  assert.equal(ago(-5 * SECOND), 'just now') // timestamp slightly in the future
})

test('minutes bucket (singular at the boundary)', () => {
  assert.equal(ago(60 * SECOND), '1 minute ago')
  assert.equal(ago(5 * MINUTE), '5 minutes ago')
  assert.equal(ago(59 * MINUTE), '59 minutes ago')
})

test('hours bucket (singular at the boundary)', () => {
  assert.equal(ago(HOUR), '1 hour ago')
  assert.equal(ago(20 * HOUR), '20 hours ago')
})

test('yesterday, then days — never a unit coarser than days', () => {
  assert.equal(ago(25 * HOUR), 'yesterday')
  assert.equal(ago(3 * DAY), '3 days ago')
  assert.equal(ago(29 * DAY), '29 days ago')
})

test('falls back to an absolute date beyond ~30 days', () => {
  // "Mon D YYYY" — not "N days ago". Asserting the shape keeps this
  // timezone-independent (the date parts render in local time).
  const dateShape = /^[A-Z][a-z]{2} \d{1,2} \d{4}$/
  assert.match(ago(30 * DAY), dateShape)
  assert.match(ago(200 * DAY), dateShape)
  assert.doesNotMatch(ago(29 * DAY), dateShape)
})
