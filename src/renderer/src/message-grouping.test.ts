import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupToolMessages, toolLabel, type ChatRenderItem } from './message-grouping'
import type { DisplayMessage } from './message-parsing'

let idCounter = 0
function assistant(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return { id: `a${++idCounter}`, role: 'assistant', content: '', timestamp: 0, ...over }
}
function toolTurn(name: string): DisplayMessage {
  return assistant({ toolCalls: [{ id: `tc${++idCounter}`, name, arguments: '{}' }] })
}
function result(): DisplayMessage {
  return { id: `r${++idCounter}`, role: 'toolResult', content: 'output', timestamp: 0 }
}
function prose(text = 'hello'): DisplayMessage {
  return assistant({ content: text })
}
function user(): DisplayMessage {
  return { id: `u${++idCounter}`, role: 'user', content: 'hi', timestamp: 0 }
}

function titles(items: ChatRenderItem[]): string[] {
  return items.filter((i) => i.kind === 'toolGroup').map((i) => (i as { title: string }).title)
}

test('folds a run of same-tool turns into one titled group', () => {
  const items = groupToolMessages([
    user(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    prose('Here are three stories'),
  ])
  // user, group, prose
  assert.equal(items.length, 3)
  assert.equal(items[0].kind, 'message')
  assert.equal(items[1].kind, 'toolGroup')
  assert.equal(items[2].kind, 'message')
  assert.deepEqual(titles(items), ['Fetched 3 URLs'])
  assert.equal((items[1] as { messages: DisplayMessage[] }).messages.length, 6)
})

test('a single tool call is not grouped', () => {
  const items = groupToolMessages([toolTurn('read_file'), result()])
  assert.equal(items.length, 2)
  assert.ok(items.every((i) => i.kind === 'message'))
})

test('mixed tools get the generic title', () => {
  const items = groupToolMessages([
    toolTurn('read_file'),
    result(),
    toolTurn('web_fetch'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Ran 2 tools'])
})

test('prose turn breaks a run into two groups', () => {
  const items = groupToolMessages([
    toolTurn('bash'),
    result(),
    toolTurn('bash'),
    result(),
    prose('done phase one'),
    toolTurn('read_file'),
    result(),
    toolTurn('read_file'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Ran 2 commands', 'Read 2 files'])
})

test('thinking-only turn rides along in the group without breaking it', () => {
  const thinkingOnly = assistant({ thinking: 'let me think', content: '' })
  const items = groupToolMessages([
    toolTurn('web_fetch'),
    result(),
    thinkingOnly,
    toolTurn('web_fetch'),
    result(),
  ])
  // One group; the thinking turn is absorbed (count stays at the 2 tool calls).
  assert.deepEqual(titles(items), ['Fetched 2 URLs'])
  assert.equal((items[0] as { messages: DisplayMessage[] }).messages.length, 5)
})

test('multiple tool calls in a single assistant turn count toward the threshold', () => {
  const twoCalls = assistant({
    toolCalls: [
      { id: 'x1', name: 'read_file', arguments: '{}' },
      { id: 'x2', name: 'read_file', arguments: '{}' },
    ],
  })
  const items = groupToolMessages([twoCalls, result(), result()])
  assert.deepEqual(titles(items), ['Read 2 files'])
})

test('toolLabel maps known tools and falls back to raw name', () => {
  assert.equal(toolLabel('web_fetch'), 'Fetch URL')
  assert.equal(toolLabel('bash'), 'Run command')
  assert.equal(toolLabel('some_custom_tool'), 'some_custom_tool')
})
