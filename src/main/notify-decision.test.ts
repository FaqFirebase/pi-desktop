import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldNotify } from './notify-decision'

const BASE = {
  enabled: true,
  windowFocused: false,
  eventWorkspaceId: 'ws-1',
  activeWorkspaceId: 'ws-1',
}

test('disabled setting suppresses everything', () => {
  assert.equal(shouldNotify({ ...BASE, enabled: false }), false)
  assert.equal(
    shouldNotify({ ...BASE, enabled: false, eventWorkspaceId: 'ws-2', windowFocused: false }),
    false,
  )
})

test('unknown event workspace never notifies', () => {
  assert.equal(shouldNotify({ ...BASE, eventWorkspaceId: null }), false)
})

test('focused window suppresses only the active workspace', () => {
  assert.equal(shouldNotify({ ...BASE, windowFocused: true }), false)
  assert.equal(shouldNotify({ ...BASE, windowFocused: true, eventWorkspaceId: 'ws-2' }), true)
})

test('unfocused window notifies for active and background workspaces', () => {
  assert.equal(shouldNotify({ ...BASE, windowFocused: false }), true)
  assert.equal(shouldNotify({ ...BASE, windowFocused: false, eventWorkspaceId: 'ws-2' }), true)
})

test('no active workspace still notifies for a background event', () => {
  assert.equal(
    shouldNotify({ ...BASE, activeWorkspaceId: null, windowFocused: true }),
    true,
  )
})
