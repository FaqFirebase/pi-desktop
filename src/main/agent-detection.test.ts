import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidatePaths, AGENT_BINARIES } from './agent-detection'

test('every agent has a binary base name', () => {
  assert.equal(AGENT_BINARIES.pi, 'pi')
  assert.equal(AGENT_BINARIES.claude, 'claude')
  assert.equal(AGENT_BINARIES.codex, 'codex')
})

test('candidatePaths returns non-empty list for linux', () => {
  const paths = candidatePaths('claude', { isWindows: false, home: '/home/u', env: {} })
  assert.ok(paths.length > 0)
  assert.ok(paths.some((p) => p.includes('claude')))
  assert.ok(paths.some((p) => p.includes('/usr/') || p.includes('/home/u')))
})

test('candidatePaths uses .cmd names on windows', () => {
  const paths = candidatePaths('codex', {
    isWindows: true,
    home: 'C:\\Users\\u',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
  })
  assert.ok(paths.some((p) => p.toLowerCase().endsWith('codex.cmd')))
})
