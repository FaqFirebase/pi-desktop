import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLAUDE_CLI_PROVIDER_ID, splitClaudeCliMarkers } from './claude-cli-markers'

const OTHER_PROVIDER = 'anthropic'

const split = (text: string, streaming = false) =>
  splitClaudeCliMarkers(text, CLAUDE_CLI_PROVIDER_ID, streaming)

test('text without markers passes through unchanged', () => {
  assert.deepEqual(split('hello [link](x)'), { content: 'hello [link](x)', toolCalls: [] })
})

test('concatenated call markers become tool calls and leave the prose', () => {
  const text =
    '[Claude Code · Bash {"command":"grep -rn \\"a]b\\" src | head"}][Claude Code · Read {"file_path":"/x/y.tsx","offset":1}]' +
    'Locating the component.[Claude Code · TodoWrite]'
  const { content, toolCalls } = split(text)
  assert.equal(content, 'Locating the component.')
  assert.deepEqual(
    toolCalls.map((tc) => [tc.name, JSON.parse(tc.arguments)]),
    [
      ['Bash', { command: 'grep -rn "a]b" src | head' }],
      ['Read', { file_path: '/x/y.tsx', offset: 1 }],
      ['TodoWrite', {}],
    ]
  )
  assert.equal(new Set(toolCalls.map((tc) => tc.id)).size, 3)
})

test('result markers pair with their call by id', () => {
  const text =
    '[Claude Code · Bash #tu_1 {"command":"ls"}][Claude Code · Read #tu_2 {"file_path":"a"}]' +
    '[Claude Code · result #tu_2 {"status":"error","tool":"Read","summary":"not found"}]' +
    '[Claude Code · result #tu_1 {"status":"ok","tool":"Bash"}]' +
    '[Claude Code · result #tu_9 {"status":"ok"}]'
  const { content, toolCalls } = split(text)
  assert.equal(content, '')
  assert.deepEqual(
    toolCalls.map((tc) => [tc.id, tc.result, tc.isError]),
    [
      ['tu_1', '{"status":"ok","tool":"Bash"}', false],
      ['tu_2', 'not found', true],
    ]
  )
})

test('a marker cut off mid-stream is hidden, not shown as prose', () => {
  const { content, toolCalls } = split('Looking.[Claude Code · Bash {"command":"ls -')
  assert.equal(content, 'Looking.')
  assert.equal(toolCalls.length, 0)
})

test('a marker arriving character by character never flashes its raw prefix', () => {
  const marker = '[Claude Code · Read #call-1 {"file_path":"test.ts"}]'
  for (let length = 1; length <= marker.length; length++) {
    const parsed = split(`Checking.${marker.slice(0, length)}`, true)
    assert.equal(parsed.content, 'Checking.', `chunk ending at ${length}`)
  }
  assert.equal(split(`Checking.${marker}`, true).toolCalls[0]?.name, 'Read')
})

test('an ambiguous prefix is released as prose when disambiguated or finalized', () => {
  assert.equal(split('Text [C', true).content, 'Text ')
  assert.equal(split('Text [Custom]', true).content, 'Text [Custom]')
  assert.equal(split('Text [C').content, 'Text [C')
})

test('malformed markers stay prose', () => {
  const text = '[Claude Code · Bash {not json}] and [Claude Code · Read extra]'
  assert.deepEqual(split(text), { content: text, toolCalls: [] })
})

test('text from any other provider is never rewritten', () => {
  const quoted = 'The tool prints [Claude Code · Bash] lines.'
  assert.deepEqual(splitClaudeCliMarkers(quoted, OTHER_PROVIDER), { content: quoted, toolCalls: [] })
  assert.deepEqual(splitClaudeCliMarkers(quoted, undefined), { content: quoted, toolCalls: [] })
  assert.equal(splitClaudeCliMarkers('The value is arr[', OTHER_PROVIDER, true).content, 'The value is arr[')
})
