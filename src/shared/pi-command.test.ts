import assert from 'node:assert/strict'
import { test } from 'node:test'
import { t, type Translate } from './i18n'
import {
  BUILTIN_SOURCE,
  commandDisplayName,
  commandSourceLabel,
  filterCommands,
  groupCommands,
  guiCommandFor,
  invocationToken,
  isPiBuiltInExtensionCommand,
  isSlashCommandToken,
  skillDisplayName,
  withGuiCommands,
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

test('OMP commands carry no source info and are never flagged as Pi built-ins', () => {
  // Shape of OMP's get_available_commands entries.
  assert.equal(isPiBuiltInExtensionCommand({ name: 'compact', source: 'builtin', input: { hint: 'focus' } }), false)
  assert.equal(isPiBuiltInExtensionCommand({ name: 'deploy', source: 'extension', input: { hint: 'arguments' } }), false)
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

test('without a query, groups come skills, prompts, builtins, extensions', () => {
  const mixed: PiCommand[] = [
    { name: 'deploy', description: '', source: 'extension' },
    { name: 'compact', description: '', source: BUILTIN_SOURCE },
    { name: 'review', description: '', source: 'prompt' },
    { name: 'skill:plan', description: '', source: 'skill' },
  ]
  const { grouped } = groupCommands(filterCommands(mixed, ''))
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
  const { flat } = groupCommands(filterCommands(mixed, ''))
  assert.deepEqual(
    flat.map((c) => c.name),
    ['skill:plan', 'review', 'deploy', 'mystery']
  )
})

// Live OMP test: typing `/model` and Enter ran `/skill:claude-api`, a skill
// that only mentions models in its description, because skills came first.
const OMP_CATALOG: PiCommand[] = [
  { name: 'skill:claude-api', description: 'Build apps with the Claude API; choose a model', source: 'skill' },
  { name: 'skill:model-audit', description: 'Audit a model', source: 'skill' },
  { name: 'switch', description: 'Switch model for this session only', source: BUILTIN_SOURCE },
  { name: 'models-sync', description: 'Sync the model list', source: 'extension' },
  { name: 'model', description: 'Show current model selection', source: BUILTIN_SOURCE },
]

test('an exact command name ranks first, then command prefixes, then skills, then description matches', () => {
  const ranked = filterCommands(OMP_CATALOG, '/model')
  assert.deepEqual(ranked.map((c) => c.name), ['model', 'models-sync', 'skill:model-audit', 'switch', 'skill:claude-api'])
  const { flat } = groupCommands(ranked)
  assert.equal(flat[0].name, 'model', 'Enter runs the exact command')
})

test('a skill still comes first when no command matches its name', () => {
  assert.equal(filterCommands(OMP_CATALOG, 'claude')[0].name, 'skill:claude-api')
  assert.equal(filterCommands(OMP_CATALOG, 'skill:cl')[0].name, 'skill:claude-api')
})

test('a GUI action replaces the agent built-in of the same name, so each command is listed once', () => {
  const agent: PiCommand[] = [
    { name: 'compact', description: 'Compact the conversation', source: BUILTIN_SOURCE },
    { name: 'usage', description: 'Show token usage', source: BUILTIN_SOURCE },
    { name: 'compact', description: 'A prompt template', source: 'prompt' },
  ]
  const gui = [{ name: 'compact', description: 'Compact the context', run: () => {} }]
  const merged = withGuiCommands(agent, gui)
  assert.deepEqual(merged.map((c) => `${c.source}:${c.name}`), ['builtin:usage', 'prompt:compact', 'builtin:compact'])
  assert.equal(merged.filter((c) => c.source === BUILTIN_SOURCE && c.name === 'compact').length, 1)
})

test('only a GUI action runs in the GUI; an agent built-in without one is sent as text', () => {
  const gui = [{ name: 'model', description: 'Choose the model', run: () => {} }]
  assert.equal(guiCommandFor({ name: 'model', description: '', source: BUILTIN_SOURCE }, gui), gui[0])
  assert.equal(guiCommandFor({ name: 'usage', description: '', source: BUILTIN_SOURCE }, gui), undefined)
  assert.equal(guiCommandFor({ name: 'model', description: '', source: 'prompt' }, gui), undefined)
  assert.equal(invocationToken('usage', BUILTIN_SOURCE), '/usage ')
})
