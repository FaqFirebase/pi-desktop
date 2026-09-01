import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSessionPreview, getSessionTitle } from './session-title'

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

test('prefers an explicit name over a message preview', () => {
  assert.equal(
    getSessionTitle('debug token refresh', '2026-07-04T13-34-18-375Z_019f2d56', 'Refactor auth'),
    'debug token refresh'
  )
})

test('falls back to a message preview when the session is unnamed', () => {
  assert.equal(
    getSessionTitle(null, '2026-07-04T13-34-18-375Z_019f2d56', 'Refactor auth module login'),
    'Refactor auth module login'
  )
})

test('falls back to a message preview when the name was cleared to whitespace', () => {
  assert.equal(getSessionTitle('   ', '019f2d6c-7d8e', 'Write unit tests'), 'Write unit tests')
})

test('trims a message preview', () => {
  assert.equal(getSessionTitle(null, 'x', '  Fix token refresh  '), 'Fix token refresh')
})

test('falls back to the timestamp when neither a name nor a preview exists', () => {
  // An empty-string preview must not win over the timestamp.
  assert.equal(
    getSessionTitle(null, '2026-07-04T13-34-18-375Z_019f2d56', null),
    '2026-07-04 13:34:18'
  )
  assert.equal(
    getSessionTitle(null, '2026-07-04T13-34-18-375Z_019f2d56', '   '),
    '2026-07-04 13:34:18'
  )
})

const SESSION_ROWS = [
  { path: '/home/u/.pi/sessions/a.jsonl', preview: 'Explain this project structure' },
  { path: '/home/u/.pi/sessions/b.jsonl', preview: null },
]

test('finds the active session preview by session file', () => {
  assert.equal(
    findSessionPreview(SESSION_ROWS, '/home/u/.pi/sessions/a.jsonl'),
    'Explain this project structure'
  )
})

test('titles the active session with its preview, matching its Recent row', () => {
  // Regression: the Current Session panel showed the raw id while the same
  // session's Recent row showed the first user message.
  const preview = findSessionPreview(SESSION_ROWS, '/home/u/.pi/sessions/a.jsonl')
  assert.equal(
    getSessionTitle(null, '019f2d6c-7d8e-7e90-8c65-fa9a3f38fc32', preview),
    'Explain this project structure'
  )
})

test('has no preview for an unlisted, unknown or previewless session file', () => {
  assert.equal(findSessionPreview(SESSION_ROWS, '/home/u/.pi/sessions/missing.jsonl'), null)
  assert.equal(findSessionPreview(SESSION_ROWS, null), null)
  assert.equal(findSessionPreview(SESSION_ROWS, undefined), null)
  assert.equal(findSessionPreview(SESSION_ROWS, '/home/u/.pi/sessions/b.jsonl'), null)
})
