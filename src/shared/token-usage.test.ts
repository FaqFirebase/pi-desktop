import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addTokenUsage, cacheTokenUsage, emptyTokenUsage, totalTokenUsage } from './token-usage'

test('total adds all four disjoint categories', () => {
  const usage = { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 }
  assert.equal(totalTokenUsage(usage), 1170)
  assert.equal(cacheTokenUsage(usage), 1050)
})

test('addTokenUsage sums every category in place', () => {
  const target = emptyTokenUsage()
  addTokenUsage(target, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  addTokenUsage(target, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })
  assert.deepEqual(target, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 })
})
