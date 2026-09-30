import assert from 'node:assert/strict'
import { test } from 'node:test'
import { t, type Translate } from './i18n'
import {
  BUILTIN_SOURCE,
  commandDisplayName,
  commandSourceLabel,
  filterCommands,
  groupCommands,
  invocationToken,
  isPiBuiltInExtensionCommand,
  isSlashCommandToken,
  skillDisplayName,
  type PiCommand,
} from './pi-command'

const cmds: PiCommand[] = [
  { name: 'skill:web-search', description: 'Search the web', source: 'skill' },
  { name: 'review', description: 'Review a diff', source: 'prompt' },
  { name: 'deploy', description: 'Deploy via extension', source: 'extension' },
]

test('only commands from Pi built-in extensions are flagged as built-in', () => {
  const llama = {
    name: 'llama',
    source: 'extension',
    sourceInfo: { path: '<inline:llama.cpp>', source: 'inline', scope: 'temporary', origin: 'top-level' },
  }
  const userExtension = {
    name: 'deploy',
    source: 'extension',
    sourceInfo: { path: '/home/u/.pi/agent/extensions/deploy.ts', source: 'local', scope: 'user', origin: 'top-level' },
  }
  assert.equal(isPiBuiltInExtensionCommand(llama), true)
  assert.equal(isPiBuiltInExtensionCommand(userExtension), false)
  assert.equal(isPiBuiltInExtensionCommand({ name: 'review', source: 'prompt' }), false)
  assert.equal(isPiBuiltInExtensionCommand(null), false)
})

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

test('skillDisplayName strips the skill: prefix only once and only at the start', () => {
  assert.equal(skillDisplayName('skill:plan'), 'plan')
  assert.equal(skillDisplayName('plan'), 'plan')
  assert.equal(skillDisplayName('my-skill:plan'), 'my-skill:plan')
})

test('commandDisplayName drops the skill: prefix from skills (issue #60)', () => {
  assert.equal(commandDisplayName(cmds[0]), 'web-search')
})

test('commandDisplayName shows built-ins in slash form and others as-is', () => {
  assert.equal(commandDisplayName({ name: 'compact', description: '', source: BUILTIN_SOURCE }), '/compact')
  assert.equal(commandDisplayName(cmds[1]), 'review')
  assert.equal(commandDisplayName(cmds[2]), 'deploy')
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

test('commandSourceLabel translates known sources', () => {
  assert.deepEqual(
    ['skill', 'prompt', BUILTIN_SOURCE, 'extension'].map((source) => commandSourceLabel(source, t)),
    ['skill', 'prompt', 'builtin', 'extension']
  )
})

test('commandSourceLabel shows an unknown source as Pi sent it', () => {
  const unknownSource = 'plugin'
  let translatorCalled = false
  const spy = ((key: string) => {
    translatorCalled = true
    return key
  }) as unknown as Translate
  assert.equal(commandSourceLabel(unknownSource, spy), unknownSource)
  assert.equal(translatorCalled, false)
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
