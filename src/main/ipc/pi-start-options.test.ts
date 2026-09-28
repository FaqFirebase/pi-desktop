import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'

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

const RESUME_ON = { ...DEFAULT_SETTINGS, resumeLastSession: true }

function resolvedContinueSession(rawOptions: unknown): boolean | undefined {
  const { applyResumePreference, validateStartOptions } = startOptions
  return applyResumePreference(validateStartOptions(rawOptions), RESUME_ON).continueSession
}

test('an unset continueSession follows the resume preference', () => {
  assert.equal(resolvedContinueSession({}), true)
})

test('an explicit continueSession false survives validation and the resume preference', () => {
  assert.equal(resolvedContinueSession({ continueSession: false }), false)
})

test('continueSession must be a boolean', () => {
  assert.throws(() => startOptions.validateStartOptions({ continueSession: 'no' }), /continueSession/)
})
