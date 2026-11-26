import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CRASH_RELOAD_WINDOW_MS, crashRecoveryAction } from './renderer-crash-recovery'

const base = { reason: 'crashed', isQuitting: false, windowDestroyed: false, now: 1_000_000, lastReloadAt: null }

test('reloads the first crash', () => assert.equal(crashRecoveryAction(base), 'reload'))

test('asks instead of reloading when the last automatic reload was inside the window', () => {
  assert.equal(crashRecoveryAction({ ...base, lastReloadAt: base.now - CRASH_RELOAD_WINDOW_MS + 1 }), 'ask')
})

test('reloads again once the window has passed', () => {
  assert.equal(crashRecoveryAction({ ...base, lastReloadAt: base.now - CRASH_RELOAD_WINDOW_MS }), 'reload')
})

test('ignores clean exits and crashes during quit', () => {
  assert.equal(crashRecoveryAction({ ...base, reason: 'clean-exit' }), 'ignore')
  assert.equal(crashRecoveryAction({ ...base, isQuitting: true }), 'ignore')
  assert.equal(crashRecoveryAction({ ...base, windowDestroyed: true }), 'ignore')
})

test('every other reason counts as a crash', () => {
  for (const reason of ['abnormal-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure']) {
    assert.equal(crashRecoveryAction({ ...base, reason }), 'reload')
  }
})
