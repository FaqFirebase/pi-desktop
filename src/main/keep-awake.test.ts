import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKeepAwake, KEEP_AWAKE_BLOCKER_TYPE, type PowerBlocker } from './keep-awake'

interface FakeBlocker extends PowerBlocker {
  readonly startedTypes: string[]
  readonly stoppedIds: number[]
  /** Simulates the OS dropping a blocker behind the app's back. */
  drop(id: number): void
}

function createFakeBlocker(): FakeBlocker {
  const live = new Set<number>()
  const startedTypes: string[] = []
  const stoppedIds: number[] = []
  let nextId = 1
  return {
    startedTypes,
    stoppedIds,
    start(type) {
      startedTypes.push(type)
      const id = nextId++
      live.add(id)
      return id
    },
    stop(id) {
      stoppedIds.push(id)
      live.delete(id)
    },
    isStarted: (id) => live.has(id),
    drop: (id) => void live.delete(id),
  }
}

test('apply(true) starts one blocker of the keep-awake type', () => {
  const blocker = createFakeBlocker()
  const keepAwake = createKeepAwake(blocker)

  assert.equal(keepAwake.apply(true), true)
  assert.deepEqual(blocker.startedTypes, [KEEP_AWAKE_BLOCKER_TYPE])
  assert.equal(keepAwake.isActive(), true)
})

test('repeated apply(true) does not stack blockers', () => {
  const blocker = createFakeBlocker()
  const keepAwake = createKeepAwake(blocker)

  keepAwake.apply(true)
  keepAwake.apply(true)
  keepAwake.apply(true)

  assert.equal(blocker.startedTypes.length, 1)
})

test('apply(false) stops the active blocker', () => {
  const blocker = createFakeBlocker()
  const keepAwake = createKeepAwake(blocker)

  keepAwake.apply(true)
  assert.equal(keepAwake.apply(false), false)

  assert.deepEqual(blocker.stoppedIds, [1])
  assert.equal(keepAwake.isActive(), false)
})

test('apply(false) with nothing active makes no stop call', () => {
  const blocker = createFakeBlocker()
  const keepAwake = createKeepAwake(blocker)

  assert.equal(keepAwake.apply(false), false)
  assert.deepEqual(blocker.stoppedIds, [])
})

test('apply(true) starts a new blocker when the old one is no longer started', () => {
  const blocker = createFakeBlocker()
  const keepAwake = createKeepAwake(blocker)

  keepAwake.apply(true)
  blocker.drop(1)
  assert.equal(keepAwake.isActive(), false)

  assert.equal(keepAwake.apply(true), true)
  assert.equal(blocker.startedTypes.length, 2)
})

test('apply(false) does not stop a blocker that is already gone', () => {
  const blocker = createFakeBlocker()
  const keepAwake = createKeepAwake(blocker)

  keepAwake.apply(true)
  blocker.drop(1)
  keepAwake.apply(false)

  assert.deepEqual(blocker.stoppedIds, [])
})

test('the setting can be turned on again after it was turned off', () => {
  const blocker = createFakeBlocker()
  const keepAwake = createKeepAwake(blocker)

  keepAwake.apply(true)
  keepAwake.apply(false)
  assert.equal(keepAwake.apply(true), true)

  assert.equal(blocker.startedTypes.length, 2)
  assert.deepEqual(blocker.stoppedIds, [1])
})
