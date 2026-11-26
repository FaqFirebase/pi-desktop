import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claimEscape, closeEscapeSurface, createEscapeSurface, ESCAPE_KEY, openEscapeSurface } from './escape-key'

const IME_PROCESSING_KEY_CODE = 229

function keyPress(key: string, composing = false) {
  const event = {
    key, defaultPrevented: false, isComposing: composing, keyCode: composing ? IME_PROCESSING_KEY_CODE : 0,
    preventDefault: () => { event.defaultPrevented = true },
  }
  return event
}

// The chat's Escape handler skips a press whose default is prevented
// (isAbortShortcut), so a claimed Escape cannot stop the running turn.
test('a claimed Escape is marked consumed', () => {
  const event = keyPress(ESCAPE_KEY)
  assert.equal(claimEscape(event), true)
  assert.equal(event.defaultPrevented, true)
})

test('an Escape that cancels an IME composition is not claimed', () => {
  const event = keyPress(ESCAPE_KEY, true)
  assert.equal(claimEscape(event), false)
  assert.equal(event.defaultPrevented, false)
})

test('other keys are not claimed', () => {
  const event = keyPress('Enter')
  assert.equal(claimEscape(event), false)
  assert.equal(event.defaultPrevented, false)
})

test('an Escape another handler already claimed is not claimed again', () => {
  const event = keyPress(ESCAPE_KEY)
  assert.equal(claimEscape(event), true)
  assert.equal(claimEscape(event), false)
})

test('of two open surfaces only the one opened last claims a press, then the one below it', () => {
  const below = createEscapeSurface()
  const top = createEscapeSurface()
  openEscapeSurface(below)
  openEscapeSurface(top)
  try {
    const first = keyPress(ESCAPE_KEY)
    assert.equal(claimEscape(first, below), false)
    assert.equal(first.defaultPrevented, false)
    assert.equal(claimEscape(first, top), true)

    closeEscapeSurface(top)
    const second = keyPress(ESCAPE_KEY)
    assert.equal(claimEscape(second, top), false)
    assert.equal(claimEscape(second, below), true)
  } finally {
    closeEscapeSurface(top)
    closeEscapeSurface(below)
  }
})

test('a surface that is not open claims no press', () => {
  const event = keyPress(ESCAPE_KEY)
  assert.equal(claimEscape(event, createEscapeSurface()), false)
  assert.equal(event.defaultPrevented, false)
})

test('opening a surface again puts it on top', () => {
  const first = createEscapeSurface()
  const second = createEscapeSurface()
  openEscapeSurface(first)
  openEscapeSurface(second)
  openEscapeSurface(first)
  try {
    assert.equal(claimEscape(keyPress(ESCAPE_KEY), second), false)
    assert.equal(claimEscape(keyPress(ESCAPE_KEY), first), true)
  } finally {
    closeEscapeSurface(first)
    closeEscapeSurface(second)
  }
})
