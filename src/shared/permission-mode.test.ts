import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeNeedsPermissionRestart } from './permission-mode'

test('a running process that started with another mode needs a restart', () => {
  assert.equal(runtimeNeedsPermissionRestart({ status: 'running', permissionMode: 'plan-readonly' }, 'trusted'), true)
})

test('a running process that started with the saved mode needs none', () => {
  assert.equal(runtimeNeedsPermissionRestart({ status: 'running', permissionMode: 'trusted' }, 'trusted'), false)
})

test('a process that is not running reads the saved mode when it starts', () => {
  for (const status of ['stopped', 'starting', 'error'] as const) {
    assert.equal(runtimeNeedsPermissionRestart({ status, permissionMode: 'plan-readonly' }, 'trusted'), false)
  }
})

test('a process with no recorded start mode is not reported as stale', () => {
  assert.equal(runtimeNeedsPermissionRestart({ status: 'running', permissionMode: null }, 'trusted'), false)
  assert.equal(runtimeNeedsPermissionRestart({ status: 'running' }, 'trusted'), false)
})
