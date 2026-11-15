import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { KeepAwakeStatus } from '../shared/keep-awake'
import type { SleepBlockState } from './keep-awake-coordinator'
import {
  createKeepAwakeController,
  deriveKeepAwakeStatus,
  shouldHoldAwake,
  type KeepAwakeController,
} from './keep-awake-controller'

const RELEASE_DELAY_MS = 1_000

interface Harness {
  applied: boolean[]
  statuses: KeepAwakeStatus[]
  delays: number[]
  pendingCount: () => number
  /** Runs the pending timer callback and waits for the apply it starts. */
  fire: () => Promise<void>
  controller: KeepAwakeController
}

function createHarness(options: { unsupported?: boolean } = {}): Harness {
  const applied: boolean[] = []
  const statuses: KeepAwakeStatus[] = []
  const delays: number[] = []
  const timers = new Map<number, () => void>()
  let nextTimerId = 1
  let state: SleepBlockState = 'released'
  let lastApply: Promise<unknown> = Promise.resolve()

  const controller = createKeepAwakeController({
    coordinator: {
      apply(hold) {
        applied.push(hold)
        // Same sticky rule as the real coordinator: a failed hold stays unsupported after a release.
        if (hold) state = options.unsupported ? 'unsupported' : 'held'
        else if (state !== 'unsupported') state = 'released'
        lastApply = Promise.resolve(state)
        return lastApply as Promise<SleepBlockState>
      },
      getState: () => state,
    },
    releaseDelayMs: RELEASE_DELAY_MS,
    setTimer(callback, delayMs) {
      delays.push(delayMs)
      const id = nextTimerId++
      timers.set(id, callback)
      return id
    },
    clearTimer(handle) {
      timers.delete(handle as number)
    },
    onStatusChange: (status) => statuses.push(status),
  })

  return {
    applied,
    statuses,
    delays,
    pendingCount: () => timers.size,
    async fire() {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, callback] of pending) callback()
      await lastApply
      // Let the controller's own continuation after the apply run.
      await new Promise((resolve) => setImmediate(resolve))
    },
    controller,
  }
}

test('shouldHoldAwake holds only for always, or while-working with work', () => {
  assert.equal(shouldHoldAwake('off', false), false)
  assert.equal(shouldHoldAwake('off', true), false)
  assert.equal(shouldHoldAwake('while-working', false), false)
  assert.equal(shouldHoldAwake('while-working', true), true)
  assert.equal(shouldHoldAwake('always', false), true)
  assert.equal(shouldHoldAwake('always', true), true)
})

test('deriveKeepAwakeStatus maps each mode and state', () => {
  assert.equal(deriveKeepAwakeStatus('off', 'held'), 'off')
  assert.equal(deriveKeepAwakeStatus('off', 'unsupported'), 'off')
  assert.equal(deriveKeepAwakeStatus('always', 'held'), 'holding')
  assert.equal(deriveKeepAwakeStatus('while-working', 'released'), 'waiting-for-work')
  assert.equal(deriveKeepAwakeStatus('while-working', 'unsupported'), 'unsupported')
})

test('the controller starts off', () => {
  const h = createHarness()
  assert.equal(h.controller.getStatus(), 'off')
})

test('always holds at once and ignores work changes', async () => {
  const h = createHarness()
  const c = h.controller
  assert.equal(await c.setMode('always'), 'holding')
  await c.setWorking(true)
  await c.setWorking(false)
  assert.deepEqual(h.applied, [true])
  assert.equal(h.pendingCount(), 0)
})

test('while-working waits, holds on work, and releases after the delay', async () => {
  const h = createHarness()
  const c = h.controller
  assert.equal(await c.setMode('while-working'), 'waiting-for-work')
  assert.equal(await c.setWorking(true), 'holding')
  assert.equal(await c.setWorking(false), 'holding')
  assert.equal(h.pendingCount(), 1)
  assert.deepEqual(h.delays, [RELEASE_DELAY_MS])

  await h.fire()
  assert.deepEqual(h.applied, [false, true, false])
  assert.equal(c.getStatus(), 'waiting-for-work')
})

test('work that starts again inside the delay keeps the hold with no release', async () => {
  const h = createHarness()
  const c = h.controller
  await c.setMode('while-working')
  await c.setWorking(true)
  await c.setWorking(false)
  await c.setWorking(true)

  assert.equal(h.pendingCount(), 0)
  // Only the initial release from setMode, and one acquire.
  assert.deepEqual(h.applied, [false, true])
  assert.equal(c.getStatus(), 'holding')
})

test('turning the mode off releases at once, with no delay', async () => {
  const h = createHarness()
  const c = h.controller
  await c.setMode('while-working')
  await c.setWorking(true)
  assert.equal(await c.setMode('off'), 'off')
  assert.equal(h.applied.at(-1), false)
  assert.equal(h.pendingCount(), 0)
})

test('turning the mode off during the release delay releases at once', async () => {
  const h = createHarness()
  const c = h.controller
  await c.setMode('while-working')
  await c.setWorking(true)
  await c.setWorking(false)
  assert.equal(h.pendingCount(), 1)

  assert.equal(await c.setMode('off'), 'off')
  assert.equal(h.applied.at(-1), false)
  assert.equal(h.pendingCount(), 0)
})

test('a pending release timer does nothing after the mode changed to always', async () => {
  const h = createHarness()
  const c = h.controller
  await c.setMode('while-working')
  await c.setWorking(true)
  await c.setWorking(false)
  await c.setMode('always')

  await h.fire()
  assert.equal(h.applied.at(-1), true)
  assert.equal(c.getStatus(), 'holding')
})

test('an unsupported system shows unsupported while waiting for work', async () => {
  const h = createHarness({ unsupported: true })
  const c = h.controller
  await c.setMode('while-working')
  assert.equal(await c.setWorking(true), 'unsupported')
  await c.setWorking(false)
  await h.fire()
  assert.equal(c.getStatus(), 'unsupported')
})

test('onStatusChange fires only on a change', async () => {
  const h = createHarness()
  const c = h.controller
  await c.setMode('always')
  await c.setWorking(true)
  await c.setWorking(true)
  assert.deepEqual(h.statuses, ['holding'])
})
