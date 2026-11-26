import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyExtensionStatus, DEFAULT_EXTENSION_STATUS_KEY } from './extension-status'

test('a status text sets its key and leaves the other keys alone', () => {
  const first = applyExtensionStatus(undefined, 'usage', '5h 35%')
  assert.deepEqual(first, { usage: '5h 35%' })
  assert.deepEqual(applyExtensionStatus(first, 'git', 'clean'), { usage: '5h 35%', git: 'clean' })
  assert.deepEqual(applyExtensionStatus(first, 'usage', '5h 36%'), { usage: '5h 36%' })
  assert.deepEqual(first, { usage: '5h 35%' }, 'the previous map is not changed')
})

test('no text clears the key, and the last cleared key leaves no map', () => {
  const statuses = { usage: '5h 35%', git: 'clean' }
  assert.deepEqual(applyExtensionStatus(statuses, 'git', undefined), { usage: '5h 35%' })
  assert.equal(applyExtensionStatus({ usage: '5h 35%' }, 'usage', undefined), undefined)
})

test('a text that is not a string clears the key like no text', () => {
  assert.equal(applyExtensionStatus({ usage: '5h 35%' }, 'usage', 42), undefined)
  assert.equal(applyExtensionStatus({ usage: '5h 35%' }, 'usage', null), undefined)
})

test('a request that changes nothing returns the same map', () => {
  const statuses = { usage: '5h 35%' }
  assert.equal(applyExtensionStatus(statuses, 'usage', '5h 35%'), statuses)
  assert.equal(applyExtensionStatus(statuses, 'git', undefined), statuses)
  assert.equal(applyExtensionStatus(undefined, 'git', undefined), undefined)
})

test('a request without a key uses the default key', () => {
  assert.deepEqual(applyExtensionStatus(undefined, undefined, 'ready'), { [DEFAULT_EXTENSION_STATUS_KEY]: 'ready' })
  assert.equal(applyExtensionStatus({ [DEFAULT_EXTENSION_STATUS_KEY]: 'ready' }, undefined, undefined), undefined)
})

test('a key named like an Object.prototype member is an ordinary key', () => {
  const statuses = applyExtensionStatus(undefined, '__proto__', 'odd')
  assert.equal(Object.getPrototypeOf(statuses), Object.prototype)
  assert.deepEqual(Object.keys(statuses ?? {}), ['__proto__'])
  assert.equal(applyExtensionStatus(statuses, '__proto__', undefined), undefined)
  assert.equal(applyExtensionStatus({ usage: '5h' }, 'toString', undefined)?.usage, '5h')
})
