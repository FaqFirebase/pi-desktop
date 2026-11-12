import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  APP_USER_MODEL_ID_ENV_VAR,
  FRAMELESS_ENV_VAR,
  WINDOW_TITLE_ENV_VAR,
  readWindowHints,
  windowTitle,
} from './window-hints'

test('without hints the window is the plain Pi Desktop window', () => {
  assert.deepEqual(readWindowHints({}), { frameless: false })
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

test('only a well-formed AppUserModelID is used', () => {
  assert.equal(readWindowHints({ [APP_USER_MODEL_ID_ENV_VAR]: 'dev.pi.desktop-gui.work' }).appUserModelId, 'dev.pi.desktop-gui.work')
  for (const bad of ['', 'has space', '.leading-dot', 'x'.repeat(129)]) {
    assert.equal(readWindowHints({ [APP_USER_MODEL_ID_ENV_VAR]: bad }).appUserModelId, undefined, bad)
  }
})

test('a frameless window is opt-in', () => {
  assert.equal(readWindowHints({ [FRAMELESS_ENV_VAR]: '1' }).frameless, true)
  assert.equal(readWindowHints({ [FRAMELESS_ENV_VAR]: '0' }).frameless, false)
})
