import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isImeComposing } from './ime-composing'

test('Enter that confirms an IME conversion is a composing key (issue #71)', () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 13 }), true)
})

test('keyCode 229 marks IME processing where isComposing is missing', () => {
  assert.equal(isImeComposing({ keyCode: 229 }), true)
})

test('an ordinary key press is not composing', () => {
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false)
  assert.equal(isImeComposing({}), false)
})
