import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterCommands, type PiCommand } from './pi-command'

const cmds: PiCommand[] = [
  { name: 'skill:web-search', description: 'Search the web', source: 'skill' },
  { name: 'review', description: 'Review a diff', source: 'prompt' },
  { name: 'deploy', description: 'Deploy via extension', source: 'extension' },
]

test('empty query returns all commands', () => {
  assert.equal(filterCommands(cmds, '').length, 3)
})

test('matches on name (case-insensitive)', () => {
  const r = filterCommands(cmds, 'WEB')
  assert.equal(r.length, 1)
  assert.equal(r[0].name, 'skill:web-search')
})

test('matches on description', () => {
  const r = filterCommands(cmds, 'diff')
  assert.equal(r.length, 1)
  assert.equal(r[0].name, 'review')
})

test('strips a single leading slash from the query', () => {
  assert.equal(filterCommands(cmds, '/review').length, 1)
})

test('no match returns empty array', () => {
  assert.deepEqual(filterCommands(cmds, 'zzz'), [])
})
