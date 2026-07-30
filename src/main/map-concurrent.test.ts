import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapWithConcurrency } from './map-concurrent'

/** Resolves only once released, so overlap is observable. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  return { promise, release }
}

test('maps every item and keeps results in input order', async () => {
  const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10)
  assert.deepEqual(out, [10, 20, 30, 40, 50])
})

test('keeps results positional even when later items finish first', async () => {
  const gates = [gate(), gate()]
  const running = mapWithConcurrency([0, 1], 2, async (i) => {
    await gates[i].promise
    return `item-${i}`
  })
  gates[1].release()
  gates[0].release()
  assert.deepEqual(await running, ['item-0', 'item-1'])
})

test('never runs more than the limit concurrently', async () => {
  const LIMIT = 3
  let active = 0
  let peak = 0
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), LIMIT, async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
  })
  assert.equal(peak, LIMIT, `peak concurrency was ${peak}`)
})

test('starts a queued item as soon as a slot frees', async () => {
  // With limit 1 and 3 items, the mapper must be entered 3 times sequentially.
  const order: number[] = []
  await mapWithConcurrency([1, 2, 3], 1, async (n) => {
    order.push(n)
    await new Promise((resolve) => setImmediate(resolve))
  })
  assert.deepEqual(order, [1, 2, 3])
})

test('returns an empty array for no items without calling the mapper', async () => {
  let calls = 0
  const out = await mapWithConcurrency([], 4, async () => {
    calls += 1
  })
  assert.deepEqual(out, [])
  assert.equal(calls, 0)
})

test('tolerates a limit larger than the item count', async () => {
  const out = await mapWithConcurrency([1, 2], 99, async (n) => n + 1)
  assert.deepEqual(out, [2, 3])
})

test('treats a non-positive limit as sequential rather than stalling', async () => {
  const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n)
  assert.deepEqual(out, [1, 2, 3])
})

test('rejects when the mapper throws', async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('mapper failed')
      return n
    }),
    /mapper failed/
  )
})
