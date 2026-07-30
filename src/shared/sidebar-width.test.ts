import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  resolveSidebarWidth,
} from './sidebar-width'

test('the default width sits inside the allowed range', () => {
  assert.ok(MIN_SIDEBAR_WIDTH < MAX_SIDEBAR_WIDTH)
  assert.ok(DEFAULT_SIDEBAR_WIDTH >= MIN_SIDEBAR_WIDTH)
  assert.ok(DEFAULT_SIDEBAR_WIDTH <= MAX_SIDEBAR_WIDTH)
})

test('clampSidebarWidth keeps a width already in range', () => {
  assert.equal(clampSidebarWidth(320), 320)
  assert.equal(clampSidebarWidth(MIN_SIDEBAR_WIDTH), MIN_SIDEBAR_WIDTH)
  assert.equal(clampSidebarWidth(MAX_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH)
})

test('clampSidebarWidth pulls out-of-range widths to the bounds', () => {
  // A drag past either edge, or a hand-edited settings.json, must not be able to
  // collapse the sidebar to nothing or push the chat off screen.
  assert.equal(clampSidebarWidth(0), MIN_SIDEBAR_WIDTH)
  assert.equal(clampSidebarWidth(-500), MIN_SIDEBAR_WIDTH)
  assert.equal(clampSidebarWidth(10_000), MAX_SIDEBAR_WIDTH)
})

test('clampSidebarWidth rounds to whole pixels', () => {
  assert.equal(clampSidebarWidth(320.6), 321)
})

test('clampSidebarWidth falls back to the default for a non-numeric width', () => {
  // settings.json is user-editable, so NaN/Infinity have to be survivable.
  assert.equal(clampSidebarWidth(Number.NaN), DEFAULT_SIDEBAR_WIDTH)
  assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY), DEFAULT_SIDEBAR_WIDTH)
})

test('resolveSidebarWidth prefers an in-progress drag over the saved width', () => {
  assert.equal(resolveSidebarWidth(400, 300), 400)
})

test('resolveSidebarWidth uses the saved width when no drag is active', () => {
  assert.equal(resolveSidebarWidth(null, 300), 300)
})

test('resolveSidebarWidth falls back to the default before settings load', () => {
  // The sidebar renders before the settings IPC round-trip resolves.
  assert.equal(resolveSidebarWidth(null, undefined), DEFAULT_SIDEBAR_WIDTH)
  assert.equal(resolveSidebarWidth(null, null), DEFAULT_SIDEBAR_WIDTH)
})

test('resolveSidebarWidth clamps both sources', () => {
  assert.equal(resolveSidebarWidth(9999, null), MAX_SIDEBAR_WIDTH)
  assert.equal(resolveSidebarWidth(null, 1), MIN_SIDEBAR_WIDTH)
})
