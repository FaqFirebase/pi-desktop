import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitClaudeCliMarkers } from './claude-cli-markers'

test('text without markers passes through unchanged', () => {
  assert.deepEqual(splitClaudeCliMarkers('hola [link](x)'), { content: 'hola [link](x)', toolCalls: [] })
})

test('concatenated call markers become tool calls and leave the prose', () => {
  const text =
    '[Claude Code · Bash {"command":"grep -rn \\"a]b\\" src | head"}][Claude Code · Read {"file_path":"/x/y.tsx","offset":1}]' +
    'Ubicando el componente.[Claude Code · TodoWrite]'
  const { content, toolCalls } = splitClaudeCliMarkers(text)
  assert.equal(content, 'Ubicando el componente.')
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
  const { content, toolCalls } = splitClaudeCliMarkers(text)
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
  const { content, toolCalls } = splitClaudeCliMarkers('Mirando.[Claude Code · Bash {"command":"ls -')
  assert.equal(content, 'Mirando.')
  assert.equal(toolCalls.length, 0)
})

test('malformed markers stay prose', () => {
  const text = '[Claude Code · Bash {not json}] y [Claude Code · Read extra]'
  assert.deepEqual(splitClaudeCliMarkers(text), { content: text, toolCalls: [] })
})
