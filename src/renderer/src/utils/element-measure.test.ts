import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createMeasureRef } from './element-measure'

interface FakeElement {
  offsetHeight: number
  hidden: boolean
  /** One layout box while rendered; none under a `display: none` ancestor. */
  getClientRects(): object[]
}

const LAYOUT_BOX = {}

function fakeElement(offsetHeight: number): FakeElement {
  return {
    offsetHeight,
    hidden: false,
    getClientRects() { return this.hidden ? [] : [LAYOUT_BOX] },
  }
}

/** What a `display: none` ancestor does to an element: no layout box, and every size reads 0. */
function hide(element: FakeElement): void {
  element.hidden = true
  element.offsetHeight = 0
}

function show(element: FakeElement, offsetHeight: number): void {
  element.hidden = false
  element.offsetHeight = offsetHeight
}

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

const readHeight = ((element: FakeElement): number => element.offsetHeight) as unknown as (element: HTMLElement) => number

test('an element that mounts later is measured and then followed on resize', () => {
  const values: number[] = []
  const ref = createMeasureRef(readHeight, (value) => values.push(value))
  ref(null)
  assert.deepEqual(values, [])

  const composer = fakeElement(144)
  ref(composer as unknown as HTMLElement)
  composer.offsetHeight = 258
  observers[0].callback()
  assert.deepEqual(values, [144, 258])
  assert.deepEqual(observers[0].observed, [composer])
})

test('replacing or removing the element stops observing the old one', () => {
  const ref = createMeasureRef(readHeight, () => undefined)
  ref(fakeElement(1) as unknown as HTMLElement)
  ref(fakeElement(2) as unknown as HTMLElement)
  assert.equal(observers[0].disconnected, true)
  ref(null)
  assert.equal(observers[1].disconnected, true)
})

test('an element hidden by a display:none ancestor keeps its last real value', () => {
  // Regression: the chat panel stays mounted behind `display: none` on other
  // views. Its pane row then reported width 0, so the side panel moved under
  // the chat column while hidden and back on return, and the editor in it was
  // mounted again with its unsaved edits gone.
  const values: number[] = []
  const ref = createMeasureRef(readHeight, (value) => values.push(value))
  const row = fakeElement(1040)
  ref(row as unknown as HTMLElement)

  hide(row)
  observers[0].callback()
  assert.deepEqual(values, [1040])

  show(row, 1040)
  observers[0].callback()
  assert.deepEqual(values, [1040, 1040])
})

test('an element that mounts hidden is measured first when it shows', () => {
  const values: number[] = []
  const ref = createMeasureRef(readHeight, (value) => values.push(value))
  const row = fakeElement(0)
  hide(row)
  ref(row as unknown as HTMLElement)
  assert.deepEqual(values, [])

  show(row, 1040)
  observers[0].callback()
  assert.deepEqual(values, [1040])
})
