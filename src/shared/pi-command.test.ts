import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUILTIN_SOURCE,
  filterCommands,
  groupCommands,
  invocationToken,
  isSlashCommandToken,
  type PiCommand,
} from './pi-command'

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

test('bare slash is a command token', () => {
  assert.equal(isSlashCommandToken('/'), true)
})

test('slash followed by a name is a command token', () => {
  assert.equal(isSlashCommandToken('/skill:plan'), true)
})

test('trailing space ends the command token (issue #50)', () => {
  assert.equal(isSlashCommandToken('/skill:plan '), false)
})

test('arguments after the command are not a command token', () => {
  assert.equal(isSlashCommandToken('/skill:plan implement login'), false)
})

test('text without a leading slash is not a command token', () => {
  assert.equal(isSlashCommandToken('hello'), false)
  assert.equal(isSlashCommandToken(''), false)
  assert.equal(isSlashCommandToken(' /plan'), false)
})

test('newline ends the command token', () => {
  assert.equal(isSlashCommandToken('/plan\nmore'), false)
})

test('skill invocation token adds the skill: prefix and trailing space', () => {
  assert.equal(invocationToken('plan', 'skill'), '/skill:plan ')
})

test('skill invocation token does not double an existing skill: prefix', () => {
  assert.equal(invocationToken('skill:plan', 'skill'), '/skill:plan ')
})

test('non-skill invocation token is /name with trailing space', () => {
  assert.equal(invocationToken('review', 'prompt'), '/review ')
  assert.equal(invocationToken('deploy', 'extension'), '/deploy ')
})

test('groupCommands orders groups skills, prompts, builtins, extensions', () => {
  const mixed: PiCommand[] = [
    { name: 'deploy', description: '', source: 'extension' },
    { name: 'compact', description: '', source: BUILTIN_SOURCE },
    { name: 'review', description: '', source: 'prompt' },
    { name: 'skill:plan', description: '', source: 'skill' },
  ]
  const { grouped } = groupCommands(mixed)
  assert.deepEqual(
    grouped.map((g) => g.label),
    ['Skills', 'Prompts', 'Commands', 'Extensions']
  )
})

test('groupCommands drops empty groups', () => {
  const { grouped } = groupCommands([{ name: 'review', description: '', source: 'prompt' }])
  assert.deepEqual(
    grouped.map((g) => g.label),
    ['Prompts']
  )
})

test('groupCommands puts unknown sources in a trailing Other group', () => {
  const { grouped } = groupCommands([
    { name: 'review', description: '', source: 'prompt' },
    { name: 'mystery', description: '', source: 'plugin' },
  ])
  assert.deepEqual(
    grouped.map((g) => g.label),
    ['Prompts', 'Other']
  )
  assert.equal(grouped[1].items[0].name, 'mystery')
})

test('groupCommands flat list matches visual group order', () => {
  const mixed: PiCommand[] = [
    { name: 'deploy', description: '', source: 'extension' },
    { name: 'skill:plan', description: '', source: 'skill' },
    { name: 'mystery', description: '', source: 'plugin' },
    { name: 'review', description: '', source: 'prompt' },
  ]
  const { flat } = groupCommands(mixed)
  assert.deepEqual(
    flat.map((c) => c.name),
    ['skill:plan', 'review', 'deploy', 'mystery']
  )
})
