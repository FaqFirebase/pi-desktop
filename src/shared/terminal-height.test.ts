import assert from 'node:assert/strict'
import test from 'node:test'
import { clampTerminalHeight } from './terminal-height'

test('terminal height follows dragging within the available space', () => {
  assert.equal(clampTerminalHeight(320, 800), 320)
  assert.equal(clampTerminalHeight(240, 800), 240)
})

test('terminal height keeps a usable minimum and leaves room for chat', () => {
  assert.equal(clampTerminalHeight(20, 800), 120)
  assert.equal(clampTerminalHeight(900, 800), 640)
})

test('small or hidden containers never force the terminal beyond its available space', () => {
  assert.equal(clampTerminalHeight(256, 100), 80)
  assert.equal(clampTerminalHeight(256, 0), 0)
})
