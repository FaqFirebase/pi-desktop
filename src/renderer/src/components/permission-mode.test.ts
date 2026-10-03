import assert from 'node:assert/strict'
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_OPTIONS,
  getPermissionModeDescription,
  getPermissionModeLabel,
  isPermissionMode,
} from './permission-mode'
import { t } from '../../../shared/i18n'

assert.equal(DEFAULT_PERMISSION_MODE, 'ask-edits')

assert.deepEqual(
  PERMISSION_MODE_OPTIONS.map((option) => option.value),
  ['plan-readonly', 'ask-edits', 'ask-commands', 'trusted']
)

assert.equal(getPermissionModeLabel('plan-readonly'), 'Plan / Read-only')
assert.equal(getPermissionModeLabel('ask-edits'), 'Ask before edits')
assert.equal(getPermissionModeLabel('ask-commands'), 'Ask before commands')
assert.equal(getPermissionModeLabel('trusted'), 'Trusted')

assert.equal(getPermissionModeDescription(t, 'ask-commands', 'OMP'), 'OMP will ask before running shell commands.')
assert.equal(getPermissionModeDescription(t, 'trusted', 'Pi'), 'All Pi tools are enabled for workflows you trust.')

assert.equal(isPermissionMode('ask-edits'), true)
assert.equal(isPermissionMode('bad-mode'), false)
