import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCompact } from './format-compact'

test('formats each magnitude with its suffix', () => {
  assert.equal(formatCompact(999), '999')
  assert.equal(formatCompact(847_200), '847.2k')
  assert.equal(formatCompact(6_600_000), '6.6M')
  assert.equal(formatCompact(4_800_000_000), '4.8B')
})

test('switches to B at one billion instead of showing thousands of M', () => {
  assert.equal(formatCompact(999_999_999), '1000.0M')
  assert.equal(formatCompact(1_000_000_000), '1.0B')
})
