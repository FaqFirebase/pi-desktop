import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStaleGuard } from './stale-guard'

test('a single begin stays current until superseded', () => {
  const guard = createStaleGuard()
  const isCurrent = guard.begin()
  assert.equal(isCurrent(), true)
})

test('an older begin goes stale the moment a newer one starts', () => {
  const guard = createStaleGuard()
  const first = guard.begin()
  const second = guard.begin()

  assert.equal(first(), false, 'the superseded load must not commit its result')
  assert.equal(second(), true)
})

test('staleness is permanent — an old token never becomes current again', () => {
  const guard = createStaleGuard()
  const first = guard.begin()
  guard.begin()
  const third = guard.begin()

  assert.equal(first(), false)
  assert.equal(third(), true)
  assert.equal(first(), false)
})
