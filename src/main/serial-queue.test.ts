import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSerialQueue } from './serial-queue'

test('tasks run one at a time in call order', async () => {
  const queue = createSerialQueue()
  const events: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

  const first = queue(async () => {
    events.push('first start')
    await firstGate
    events.push('first end')
    return 'first'
  })
  const second = queue(async () => {
    events.push('second start')
    return 'second'
  })
  await Promise.resolve()
  releaseFirst()

  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(events, ['first start', 'first end', 'second start'])
})

test('a failed task rejects its caller and the next task still runs', async () => {
  const queue = createSerialQueue()
  const failed = queue(async () => { throw new Error('task failed') })
  const next = queue(async () => 'next')
  await assert.rejects(failed, /task failed/)
  assert.equal(await next, 'next')
})
