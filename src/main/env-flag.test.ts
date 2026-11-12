import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isEnvFlagOn } from './env-flag'

test('only explicit opt-in values switch a flag on', () => {
  for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) assert.equal(isEnvFlagOn(value), true, value)
  for (const value of [undefined, '', '0', 'false', 'no', 'maybe']) assert.equal(isEnvFlagOn(value), false, String(value))
})
