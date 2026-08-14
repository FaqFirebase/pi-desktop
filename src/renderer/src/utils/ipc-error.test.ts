import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatIpcError } from './ipc-error'

test('strips the Electron remote-method prefix and inner Error label', () => {
  assert.equal(
    formatIpcError(new Error("Error invoking remote method 'file:diff': Error: git diff failed: fatal: bad object HEAD")),
    'git diff failed: fatal: bad object HEAD',
  )
})

test('strips the prefix when no inner Error label is present', () => {
  assert.equal(
    formatIpcError(new Error("Error invoking remote method 'file:diff': No active workspace")),
    'No active workspace',
  )
})

test('passes through plain errors and non-Error values', () => {
  assert.equal(formatIpcError(new Error('plain failure')), 'plain failure')
  assert.equal(formatIpcError('string failure'), 'string failure')
})
