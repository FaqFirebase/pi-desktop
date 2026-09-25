import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSerialRunner } from './serial-runner'

const SLOW_TASK_MS = 20

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('overlapping tasks never run at the same time', async () => {
  const run = createSerialRunner()
  let active = 0
  let maxActive = 0
  const task = async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await delay(SLOW_TASK_MS)
    active--
  }
  await Promise.all([run(task), run(task), run(task)])
  assert.equal(maxActive, 1)
})

test('tasks run in call order and return their own results', async () => {
  const run = createSerialRunner()
  const order: string[] = []
  const first = run(async () => {
    await delay(SLOW_TASK_MS)
    order.push('first')
    return 'a'
  })
  const second = run(async () => {
    order.push('second')
    return 'b'
  })
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b'])
  assert.deepEqual(order, ['first', 'second'])
})

test('a failed task rejects its caller but does not block later tasks', async () => {
  const run = createSerialRunner()
  const failed = run(async () => {
    throw new Error('boom')
  })
  const next = run(async () => 'ok')
  await assert.rejects(failed, /boom/)
  assert.equal(await next, 'ok')
})
