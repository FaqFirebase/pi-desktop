import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import type { AgentEngineKind, AppSettings } from '../../shared/ipc-contracts'
import { NEXT_STEPS_EXTENSION_FILE, NEXT_STEPS_TOOL_NAME } from '../../../resources/next-steps'
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

const RESUME_ON = { ...DEFAULT_SETTINGS, resumeLastSession: true }

function resolvedContinueSession(rawOptions: unknown): boolean | undefined {
  const { applyResumePreference, validateStartOptions } = startOptions
  return applyResumePreference(validateStartOptions(rawOptions), RESUME_ON).continueSession
}

function launchArgs(rawOptions: unknown): string[] {
  const { applyResumePreference, validateStartOptions } = startOptions
  return buildPiArgs(applyResumePreference(validateStartOptions(rawOptions), RESUME_ON))
}

test('an unset continueSession follows the resume preference', () => {
  assert.equal(resolvedContinueSession({}), true)
  assert.ok(launchArgs({}).includes('--continue'))
})

test('an explicit continueSession false survives validation and the resume preference', () => {
  assert.equal(resolvedContinueSession({ continueSession: false }), false)
})

test('an explicit continueSession false starts a fresh session despite the resume preference', () => {
  assert.equal(launchArgs({ continueSession: false }).includes('--continue'), false)
})

test('continueSession must be a boolean', () => {
  assert.throws(() => startOptions.validateStartOptions({ continueSession: 'no' }), /continueSession/)
})

function permissionArgs(settings: Partial<AppSettings>, engine: AgentEngineKind = 'pi'): string[] {
  return startOptions.applyPermissionModeToStartOptions({ engine }, { ...DEFAULT_SETTINGS, ...settings }).args ?? []
}

function loadsNextSteps(args: string[]): boolean {
  return args.some((arg, index) => args[index - 1] === '-e' && basename(arg) === NEXT_STEPS_EXTENSION_FILE)
}

function listedTools(args: string[]): string[] {
  const index = args.indexOf('--tools')
  return index === -1 ? [] : args[index + 1].split(',')
}

test('the next-steps extension loads only while the setting is on', () => {
  assert.equal(loadsNextSteps(permissionArgs({ suggestNextSteps: true })), true)
  assert.equal(loadsNextSteps(permissionArgs({ suggestNextSteps: false })), false)
})

test('plan mode lists the next-steps tool on both engines while the setting is on', () => {
  for (const engine of ['pi', 'omp'] as const) {
    const on = permissionArgs({ permissionMode: 'plan-readonly', suggestNextSteps: true }, engine)
    assert.ok(listedTools(on).includes(NEXT_STEPS_TOOL_NAME), engine)
    const off = permissionArgs({ permissionMode: 'plan-readonly', suggestNextSteps: false }, engine)
    assert.equal(listedTools(off).includes(NEXT_STEPS_TOOL_NAME), false, engine)
  }
})

test('modes without a tool list get no --tools flag for next steps', () => {
  assert.deepEqual(listedTools(permissionArgs({ permissionMode: 'ask-edits', suggestNextSteps: true })), [])
})
