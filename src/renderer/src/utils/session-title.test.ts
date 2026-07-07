import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSessionTitle } from './session-title'

test('prefers an explicit session name', () => {
  assert.equal(getSessionTitle('My session', '2026-07-04T13-58-32-590Z_019f2d6c'), 'My session')
  assert.equal(getSessionTitle('  Trimmed  ', 'x'), 'Trimmed')
})

test('formats a Pi timestamp id with a distinguishable time', () => {
  // Regression: same-day sessions used to collapse to "2026-07-04T1".
  assert.equal(
    getSessionTitle(null, '2026-07-04T13-34-18-375Z_019f2d56-4d07-7856-b0e0-df198d5d34ef'),
    '2026-07-04 13:34:18'
  )
  assert.equal(
    getSessionTitle(null, '2026-07-04T13-58-32-590Z_019f2d6c-7d8e-7e90-8c65-fa9a3f38fc32'),
    '2026-07-04 13:58:32'
  )
})

test('two same-day sessions get distinct titles', () => {
  const a = getSessionTitle(null, '2026-07-04T13-34-18-375Z_019f2d56')
  const b = getSessionTitle(null, '2026-07-04T13-58-32-590Z_019f2d6c')
  assert.notEqual(a, b)
})

test('falls back to a short id for a bare UUID', () => {
  assert.equal(getSessionTitle(null, '019f2d6c-7d8e-7e90-8c65-fa9a3f38fc32'), '019f2d6c-7d8')
})

test('falls back to a short id when name is empty/whitespace', () => {
  assert.equal(getSessionTitle('', '019f2d6c-7d8e'), '019f2d6c-7d8')
  assert.equal(getSessionTitle('   ', '019f2d6c-7d8e'), '019f2d6c-7d8')
})
