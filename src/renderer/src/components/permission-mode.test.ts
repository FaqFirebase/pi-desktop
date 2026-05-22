import assert from 'node:assert/strict'
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_OPTIONS,
  getPermissionModeLabel,
  isPermissionMode,
} from './permission-mode'

assert.equal(DEFAULT_PERMISSION_MODE, 'ask-edits')

assert.deepEqual(
  PERMISSION_MODE_OPTIONS.map((option) => option.value),
  ['plan-readonly', 'ask-edits', 'ask-commands', 'trusted']
)

assert.equal(getPermissionModeLabel('plan-readonly'), 'Plan / Read-only')
assert.equal(getPermissionModeLabel('ask-edits'), 'Ask before edits')
assert.equal(getPermissionModeLabel('ask-commands'), 'Ask before commands')
assert.equal(getPermissionModeLabel('trusted'), 'Trusted')

assert.equal(isPermissionMode('ask-edits'), true)
assert.equal(isPermissionMode('bad-mode'), false)
