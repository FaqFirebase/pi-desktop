import assert from 'node:assert/strict'
import { test } from 'node:test'
import { typeSafeKeyEnv } from './typesafe-key-store'

test('the saved key is passed to the agent when the environment has none', () => {
  assert.deepEqual(typeSafeKeyEnv('ts_live_abc', {}), { TYPESAFE_API_KEY: 'ts_live_abc' })
  assert.deepEqual(typeSafeKeyEnv('ts_live_abc', { TYPESAFE_API_KEY: '' }), { TYPESAFE_API_KEY: 'ts_live_abc' })
})

test('a key already in the environment wins over the saved key', () => {
  assert.deepEqual(typeSafeKeyEnv('ts_live_abc', { TYPESAFE_API_KEY: 'from_shell' }), {})
})

test('nothing is added when no key is saved', () => {
  assert.deepEqual(typeSafeKeyEnv(null, {}), {})
})
