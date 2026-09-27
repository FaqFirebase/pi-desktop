import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import { buildPiArgs } from '../pi-rpc-manager'

let startOptions: typeof import('./pi-start-options')

before(async () => {
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  require('electron')
  require.cache[electronPath]!.exports = {
    app: { isPackaged: false, getAppPath: () => process.cwd() },
  }
  startOptions = await import('./pi-start-options')
})

const resumeOn = { ...DEFAULT_SETTINGS, resumeLastSession: true }

function launchArgs(options: unknown): string[] {
  const { validateStartOptions, applyResumePreference } = startOptions
  return buildPiArgs(applyResumePreference(validateStartOptions(options), resumeOn))
}

test('an unset continueSession follows the resume preference', () => {
  assert.ok(launchArgs({}).includes('--continue'))
})

test('an explicit continueSession false starts a fresh session despite the resume preference', () => {
  assert.equal(launchArgs({ continueSession: false }).includes('--continue'), false)
})

test('continueSession must be a boolean', () => {
  assert.throws(() => startOptions.validateStartOptions({ continueSession: 'no' }), /continueSession/)
})
