import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSingleFlight } from './single-flight'

function controlledTask(): { task: () => Promise<void>; finishRun: (error?: Error) => void; runs: () => number } {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = []
  let runs = 0
  return {
    task: () => {
      runs++
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    finishRun: (error) => {
      const run = pending.shift()!
      if (error) run.reject(error)
      else run.resolve()
    },
    runs: () => runs,
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('calls while a run is in flight share one follow-up run', async () => {
  const { task, finishRun, runs } = controlledTask()
  const run = createSingleFlight(task)

  const first = run()
  const second = run()
  const third = run()
  assert.equal(runs(), 1, 'no second run starts while the first is in flight')
  assert.equal(second, third, 'later callers share the queued run')

  finishRun()
  await first
  await settle()
  assert.equal(runs(), 2, 'the queued run starts once the first settles')

  finishRun()
  await second
  await settle()
  assert.equal(runs(), 2, 'nothing more was asked for')
})

test('a failed run still starts the queued one, and only its own caller sees the failure', async () => {
  const { task, finishRun, runs } = controlledTask()
  const run = createSingleFlight(task)

  const first = run()
  const second = run()
  finishRun(new Error('boom'))
  await assert.rejects(first, /boom/)
  await settle()
  assert.equal(runs(), 2)

  finishRun()
  await second
  const third = run()
  assert.equal(runs(), 3, 'an idle runner starts at once')
  finishRun()
  await third
})
