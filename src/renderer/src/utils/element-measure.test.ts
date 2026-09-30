import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createMeasureRef } from './element-measure'

interface FakeElement { offsetHeight: number }

const observers: FakeObserver[] = []

class FakeObserver {
  observed: unknown[] = []
  disconnected = false
  constructor(readonly callback: () => void) { observers.push(this) }
  observe(element: unknown): void { this.observed.push(element) }
  disconnect(): void { this.disconnected = true }
}

const originalObserver = globalThis.ResizeObserver

beforeEach(() => {
  observers.length = 0
  globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver
})

afterEach(() => {
  globalThis.ResizeObserver = originalObserver
})

const readHeight = (element: FakeElement): number => element.offsetHeight

test('an element that mounts later is measured and then followed on resize', () => {
  const values: number[] = []
  const ref = createMeasureRef(readHeight as unknown as (element: HTMLElement) => number, (value) => values.push(value))
  ref(null)
  assert.deepEqual(values, [])

  const composer = { offsetHeight: 144 }
  ref(composer as unknown as HTMLElement)
  composer.offsetHeight = 258
  observers[0].callback()
  assert.deepEqual(values, [144, 258])
  assert.deepEqual(observers[0].observed, [composer])
})

test('replacing or removing the element stops observing the old one', () => {
  const ref = createMeasureRef(readHeight as unknown as (element: HTMLElement) => number, () => undefined)
  ref({ offsetHeight: 1 } as unknown as HTMLElement)
  ref({ offsetHeight: 2 } as unknown as HTMLElement)
  assert.equal(observers[0].disconnected, true)
  ref(null)
  assert.equal(observers[1].disconnected, true)
})
