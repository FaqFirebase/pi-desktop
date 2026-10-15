import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPointerMovement } from './pointer-movement'

test('only a pointer that moved takes over the list selection', () => {
  assert.equal(isPointerMovement({ movementX: 0, movementY: 0 }), false)
  assert.equal(isPointerMovement({ movementX: 2, movementY: 0 }), true)
  assert.equal(isPointerMovement({ movementX: 0, movementY: -1 }), true)
})
