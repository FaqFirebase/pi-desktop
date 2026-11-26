import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent } from '../shared/ipc-contracts'
import { createAgentWorkTracker } from './agent-work-tracker'
import { createRuntimeTurnState } from './runtime-turn-state'

const AGENT_START: PiRpcEvent = { type: 'agent_start' }
const AGENT_END: PiRpcEvent = { type: 'agent_end', messages: [] }

function createHarness(): { changes: boolean[]; tracker: ReturnType<typeof createAgentWorkTracker> } {
  const changes: boolean[] = []
  return { changes, tracker: createAgentWorkTracker((working) => changes.push(working)) }
}

function deferred(): { promise: Promise<void>; reject(err: Error): void; resolve(): void } {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('one waiting runtime and one working runtime in the same workspace hold', () => {
  const { tracker } = createHarness()
  const waiting = createRuntimeTurnState()
  const working = createRuntimeTurnState()
  waiting.handleEvent(AGENT_START)
  waiting.handleEvent({ type: 'extension_ui_request', id: 'p1', method: 'confirm' })
  working.handleEvent(AGENT_START)

  tracker.setRunningTurn('rt-a', waiting.isRunningTurn())
  tracker.setRunningTurn('rt-b', working.isRunningTurn())
  assert.equal(tracker.isWorking(), true)

  working.handleEvent(AGENT_END)
  tracker.setRunningTurn('rt-b', working.isRunningTurn())
  assert.equal(tracker.isWorking(), false)
})

test('a runtime that only waits on the user does not hold', () => {
  const { tracker, changes } = createHarness()
  tracker.setRunningTurn('rt-a', false)
  assert.equal(tracker.isWorking(), false)
  assert.deepEqual(changes, [])
})

test('work stays active while any source runs', () => {
  const { tracker, changes } = createHarness()
  tracker.setRunningTurn('rt-a', true)
  tracker.setBackgroundRuns('m1', 2)
  tracker.setRunningTurn('rt-a', false)
  assert.equal(tracker.isWorking(), true)
  tracker.setBackgroundRuns('m1', 0)
  assert.equal(tracker.isWorking(), false)
  assert.deepEqual(changes, [true, false])
})

test('runWhileWorking holds during the run and ends after a rejection', async () => {
  const { tracker, changes } = createHarness()
  const run = deferred()
  const result = tracker.runWhileWorking(() => run.promise)
  assert.equal(tracker.isWorking(), true)

  run.reject(new Error('council failed'))
  await assert.rejects(result, /council failed/)
  assert.equal(tracker.isWorking(), false)
  assert.deepEqual(changes, [true, false])
})

test('runWhileWorking returns the run result', async () => {
  const { tracker } = createHarness()
  assert.equal(await tracker.runWhileWorking(async () => 42), 42)
  assert.equal(tracker.isWorking(), false)
})

test('overlapping runs end the hold only after the last one settles', async () => {
  const { tracker, changes } = createHarness()
  const first = deferred()
  const second = deferred()
  const firstRun = tracker.runWhileWorking(() => first.promise)
  const secondRun = tracker.runWhileWorking(() => second.promise)

  first.resolve()
  await firstRun
  assert.equal(tracker.isWorking(), true)

  second.resolve()
  await secondRun
  assert.equal(tracker.isWorking(), false)
  assert.deepEqual(changes, [true, false])
})

test('onChange fires only on transitions', () => {
  const { tracker, changes } = createHarness()
  tracker.setRunningTurn('rt-a', true)
  tracker.setRunningTurn('rt-a', true)
  tracker.setRunningTurn('rt-b', true)
  assert.deepEqual(changes, [true])
})
