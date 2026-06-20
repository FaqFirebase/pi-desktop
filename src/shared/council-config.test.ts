import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateCouncilConfig,
  DEFAULT_COUNCIL_CONFIG,
  type CouncilConfig,
} from './council-config'

test('default config is valid', () => {
  assert.deepEqual(validateCouncilConfig(DEFAULT_COUNCIL_CONFIG), [])
})

test('default config is disabled', () => {
  assert.equal(DEFAULT_COUNCIL_CONFIG.enabled, false)
})

test('flags timeout below minimum', () => {
  const cfg: CouncilConfig = { ...DEFAULT_COUNCIL_CONFIG, timeoutSeconds: 1 }
  assert.ok(validateCouncilConfig(cfg).some((e) => e.toLowerCase().includes('timeout')))
})

test('flags timeout above maximum', () => {
  const cfg: CouncilConfig = { ...DEFAULT_COUNCIL_CONFIG, timeoutSeconds: 10_000 }
  assert.ok(validateCouncilConfig(cfg).some((e) => e.toLowerCase().includes('timeout')))
})

test('flags non-finite timeout', () => {
  const cfg: CouncilConfig = { ...DEFAULT_COUNCIL_CONFIG, timeoutSeconds: Number.NaN }
  assert.ok(validateCouncilConfig(cfg).some((e) => e.toLowerCase().includes('timeout')))
})

test('flags unknown consensus mode', () => {
  const cfg = { ...DEFAULT_COUNCIL_CONFIG, consensusMode: 'loop' } as unknown as CouncilConfig
  assert.ok(validateCouncilConfig(cfg).some((e) => e.toLowerCase().includes('consensus')))
})
