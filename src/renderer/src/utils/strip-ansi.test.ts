import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripAnsi } from './strip-ansi'

test('terminal colors and hyperlinks are removed; plain text stays', () => {
  assert.equal(stripAnsi('System prompt [\x1b[38;5;243m░░\x1b[39m\x1b[1m\x1b[38;5;39m░\x1b[22m\x1b[39m] 0%'), 'System prompt [░░░] 0%')
  assert.equal(stripAnsi('\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\'), 'link')
  assert.equal(stripAnsi('Context window: 1000000 tokens'), 'Context window: 1000000 tokens')
})
