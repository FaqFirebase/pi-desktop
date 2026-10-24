import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampQuickChatBounds, positionQuickChatBounds, resolveQuickChatBounds, shouldHideQuickChatOnBlur } from './quick-chat-window-behavior'

const blurred = { visible: true, focused: false, ownedInteraction: false, composing: false, applicationDeactivated: false }

test('outside focus loss hides, while hidden or refocused windows stay unchanged', () => {
  assert.equal(shouldHideQuickChatOnBlur(blurred), true)
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, visible: false }), false)
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, focused: true }), false)
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, pinned: true }), false)
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, pinned: true, applicationDeactivated: true }), false)
})

test('native menus, owned dialogs, and IME candidates do not count as outside clicks', () => {
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, ownedInteraction: true }), false)
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, composing: true }), false)
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, composing: false }), true)
})

test('switching applications hides even during composition or before native focus flags settle', () => {
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, composing: true, applicationDeactivated: true }), true)
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, ownedInteraction: true, applicationDeactivated: true }), true)
  assert.equal(shouldHideQuickChatOnBlur({ ...blurred, focused: true, applicationDeactivated: true }), true)
})

test('positioning uses the active display work area, including negative display coordinates', () => {
  assert.deepEqual(positionQuickChatBounds({ width: 480, height: 640 }, { x: -1920, y: -200, width: 1920, height: 1080 }), {
    x: -1200, y: -53, width: 480, height: 640,
  })
})

test('an oversized popup fits even a work area smaller than its usual minimum', () => {
  assert.deepEqual(positionQuickChatBounds({ width: 480, height: 640 }, { x: 20, y: 30, width: 280, height: 240 }), {
    x: 20, y: 30, width: 280, height: 240,
  })
})

test('display changes clamp all edges without resizing a popup that already fits', () => {
  const workArea = { x: 100, y: 80, width: 800, height: 600 }
  assert.deepEqual(clampQuickChatBounds({ x: 0, y: 0, width: 480, height: 400 }, workArea), {
    x: 100, y: 80, width: 480, height: 400,
  })
  assert.deepEqual(clampQuickChatBounds({ x: 1000, y: 1000, width: 480, height: 400 }, workArea), {
    x: 420, y: 280, width: 480, height: 400,
  })
})

test('default bounds adapt to the current display instead of reusing the previous display size', () => {
  const currentBounds = { x: 0, y: 0, width: 500, height: 300 }
  const smallArea = { x: 0, y: 0, width: 1280, height: 720 }
  const largeArea = { x: -2560, y: -100, width: 2560, height: 1440 }
  const resolve = (workArea: typeof smallArea) => resolveQuickChatBounds({
    currentBounds, lastCustomBounds: null, userPositioned: false, workArea,
  })
  const small = resolve(smallArea)
  const large = resolve(largeArea)
  assert.ok(large.width > small.width)
  assert.ok(large.height > small.height)
  for (const [bounds, area] of [[small, smallArea], [large, largeArea]]) {
    assert.ok(bounds.x >= area.x && bounds.y >= area.y)
    assert.ok(bounds.x + bounds.width <= area.x + area.width)
    assert.ok(bounds.y + bounds.height <= area.y + area.height)
  }
})

test('default bounds fit a work area smaller than the preferred dimensions', () => {
  const area = { x: -320, y: 30, width: 320, height: 240 }
  const bounds = resolveQuickChatBounds({
    currentBounds: { x: 0, y: 0, width: 960, height: 720 },
    lastCustomBounds: null, userPositioned: false, workArea: area,
  })
  assert.ok(bounds.width <= area.width && bounds.height <= area.height)
  assert.ok(bounds.x >= area.x && bounds.y >= area.y)
  assert.ok(bounds.x + bounds.width <= area.x + area.width)
  assert.ok(bounds.y + bounds.height <= area.y + area.height)
})

test('an explicitly positioned popup keeps its custom size and location', () => {
  const custom = { x: 1200, y: 300, width: 500, height: 700 }
  assert.deepEqual(resolveQuickChatBounds({
    currentBounds: { x: 0, y: 0, width: 640, height: 420 },
    lastCustomBounds: custom, userPositioned: true,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  }), custom)
})
