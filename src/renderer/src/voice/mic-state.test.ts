import assert from 'node:assert/strict'
import { test } from 'node:test'
import { micState } from './mic-state'

const IDLE = { ready: true, phase: 'idle', error: null } as const
const FAILURE = 'Could not reach the speech server'

test('a mic with no model or server set up asks for setup, whatever else is going on', () => {
  assert.equal(micState({ ...IDLE, ready: false }), 'setUp')
  assert.equal(micState({ ...IDLE, ready: false, error: FAILURE }), 'setUp')
})

test('a failed dictation shows as failed once the mic is idle again', () => {
  assert.equal(micState(IDLE), 'idle')
  assert.equal(micState({ ...IDLE, error: FAILURE }), 'failed')
})

test('recording and transcribing show over an error from an earlier segment', () => {
  assert.equal(micState({ ...IDLE, phase: 'recording', error: FAILURE }), 'recording')
  assert.equal(micState({ ...IDLE, phase: 'transcribing', error: FAILURE }), 'transcribing')
})
