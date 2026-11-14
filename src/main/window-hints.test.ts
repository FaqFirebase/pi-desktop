import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WINDOW_TITLE_ENV_VAR, readWindowHints, windowTitle } from './window-hints'

test('without hints the window is the plain Pi Desktop window', () => {
  assert.deepEqual(readWindowHints({}), {})
  assert.equal(windowTitle('Pi Desktop', readWindowHints({})), 'Pi Desktop')
})

test('a title label is appended to the window title', () => {
  const hints = readWindowHints({ [WINDOW_TITLE_ENV_VAR]: '  Addictivity  ' })
  assert.equal(hints.titleLabel, 'Addictivity')
  assert.equal(windowTitle('Pi Desktop', hints), 'Pi Desktop — Addictivity')
})

test('a title label is cleaned of control characters and capped', () => {
  assert.equal(readWindowHints({ [WINDOW_TITLE_ENV_VAR]: 'A\nB\tC' }).titleLabel, 'A B C')
  assert.equal(readWindowHints({ [WINDOW_TITLE_ENV_VAR]: 'x'.repeat(200) }).titleLabel?.length, 80)
  assert.equal(readWindowHints({ [WINDOW_TITLE_ENV_VAR]: '   ' }).titleLabel, undefined)
})
