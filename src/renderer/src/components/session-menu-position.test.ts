import assert from 'node:assert/strict'
import { getSessionMenuPosition } from './session-menu-position'

const nearBottomRight = getSessionMenuPosition({
  triggerRect: { left: 1260, right: 1284, bottom: 772 },
  menuWidth: 150,
  menuHeight: 74,
  viewportWidth: 1300,
  viewportHeight: 780,
})

assert.deepEqual(nearBottomRight, { x: 1134, y: 698 })

const narrowViewport = getSessionMenuPosition({
  triggerRect: { left: 12, right: 36, bottom: 40 },
  menuWidth: 150,
  menuHeight: 74,
  viewportWidth: 120,
  viewportHeight: 780,
})

assert.deepEqual(narrowViewport, { x: 8, y: 46 })
