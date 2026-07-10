import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  groupToolMessages,
  toolLabel,
  toolCallLabel,
  toolCallFile,
  parseEdits,
  editStats,
  prepareChatMessages,
  splitReadTruncationNote,
  type ChatRenderItem,
} from './message-grouping'
import type { DisplayMessage } from './message-parsing'

let idCounter = 0
function assistant(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return { id: `a${++idCounter}`, role: 'assistant', content: '', timestamp: 0, ...over }
}
function toolTurn(name: string, args: Record<string, unknown> = {}): DisplayMessage {
  return assistant({ toolCalls: [{ id: `tc${++idCounter}`, name, arguments: JSON.stringify(args) }] })
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

test('mixed tools combine their verbs (first capitalized, rest lower-cased)', () => {
  const items = groupToolMessages([
    toolTurn('read_file'),
    result(),
    toolTurn('web_fetch'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Read a file, fetched a URL'])
})

test('mixed run combines counts per tool type in first-appearance order', () => {
  const items = groupToolMessages([
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('read_file'),
    result(),
    toolTurn('read_file'),
    result(),
    toolTurn('edit_file'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Fetched 4 URLs, read 2 files, edited a file'])
})

test('unknown tools bucket together under the generic verb', () => {
  const items = groupToolMessages([
    toolTurn('mystery_tool'),
    result(),
    toolTurn('another_weird_one'),
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

test('toolCallLabel shows the operated-on value (path args as basename)', () => {
  assert.equal(toolCallLabel('web_fetch', '{"url":"https://x.com/a"}'), 'Fetched https://x.com/a')
  assert.equal(toolCallLabel('read_file', '{"path":"src/app/foo.ts"}'), 'Read foo.ts')
  assert.equal(toolCallLabel('write_file', '{"path":"a/b/new.ts"}'), 'Created new.ts')
  assert.equal(toolCallLabel('edit_file', '{"file":"lib/bar.ts"}'), 'Edited bar.ts')
  assert.equal(toolCallLabel('grep', '{"pattern":"TODO"}'), 'Searched TODO')
  assert.equal(toolCallLabel('list_dir', '{"path":"src/components"}'), 'Listed components')
})

test('toolCallLabel omits the value for commands and when no arg is present', () => {
  assert.equal(toolCallLabel('bash', '{"command":"ls -la"}'), 'Ran a command')
  assert.equal(toolCallLabel('read_file', '{}'), 'Read a file')
  assert.equal(toolCallLabel('some_custom_tool', '{}'), 'some_custom_tool')
})

test('toolCallLabel truncates very long values', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(100)
  const label = toolCallLabel('web_fetch', JSON.stringify({ url: longUrl }))
  assert.ok(label.startsWith('Fetched https://example.com/'))
  assert.ok(label.endsWith('…'))
  assert.ok(label.length < longUrl.length)
})

test('toolCallFile resolves the operated-on path for file tools only', () => {
  assert.equal(toolCallFile('read_file', '{"path":"src/foo.ts"}'), 'src/foo.ts')
  assert.equal(toolCallFile('edit_file', '{"path":"a/b.py","edits":[]}'), 'a/b.py')
  assert.equal(toolCallFile('list_dir', '{"path":"src"}'), 'src')
  assert.equal(toolCallFile('web_fetch', '{"url":"https://x.com"}'), null)
  assert.equal(toolCallFile('bash', '{"command":"ls"}'), null)
})

test('parseEdits reads the edits array and editStats counts lines', () => {
  const args = JSON.stringify({
    path: 'x.py',
    edits: [
      { oldText: 'a\nb\nc', newText: 'A' },
      { oldText: '', newText: 'new1\nnew2' },
    ],
  })
  const blocks = parseEdits(args)
  assert.equal(blocks?.length, 2)
  assert.deepEqual(editStats(blocks!), { added: 3, removed: 3 })
  assert.equal(parseEdits('{"path":"x"}'), null)
  assert.equal(parseEdits('not json'), null)
})

// Helpers for prepareChatMessages: an assistant tool turn with a known call id,
// and a toolResult that pairs to it.
function callTurn(name: string, id: string, args: Record<string, unknown> = {}): DisplayMessage {
  return assistant({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] })
}
function resultFor(id: string, content = 'output'): DisplayMessage {
  return { id: `${id}-result`, role: 'toolResult', content, timestamp: 0, toolCallId: id }
}

test('prepareChatMessages hides follow-up reads of a just-edited file', () => {
  const out = prepareChatMessages([
    callTurn('edit_file', 'e1', { path: 'C:/work/btc.py', edits: [{ oldText: 'a', newText: 'b' }] }),
    resultFor('e1', 'Successfully replaced 1 block'),
    callTurn('read_file', 'r1', { path: 'btc.py' }), // same file (basename) -> hidden
    resultFor('r1', 'file body'),
    callTurn('read_file', 'r2', { path: 'other.py' }), // different file -> kept
    resultFor('r2', 'other body'),
  ])
  const ids = out.map((m) => m.id)
  assert.ok(!ids.includes('r1-result'), 'hidden read result dropped')
  assert.ok(!out.some((m) => m.toolCalls?.some((tc) => tc.id === 'r1')), 'hidden read call dropped')
  assert.ok(ids.includes('r2-result'), 'unrelated read kept')
  assert.equal(out.length, 4)
})

test('prepareChatMessages enriches tool results with paired name and file', () => {
  const out = prepareChatMessages([
    callTurn('read_file', 'r1', { path: 'src/app/foo.ts' }),
    resultFor('r1', 'export const x = 1'),
  ])
  const res = out.find((m) => m.id === 'r1-result')
  assert.equal(res?.toolName, 'read_file')
  assert.equal(res?.toolFile, 'src/app/foo.ts')
})

test('splitReadTruncationNote peels off Pi read footer and trailing blanks', () => {
  const content = 'line1\nline2\n\n[262 more lines in file. Use offset=21 to continue.]'
  const { code, note } = splitReadTruncationNote(content)
  assert.equal(code, 'line1\nline2')
  assert.equal(note, '[262 more lines in file. Use offset=21 to continue.]')
})

test('splitReadTruncationNote leaves untruncated content untouched', () => {
  const content = 'line1\nline2\nline3'
  const { code, note } = splitReadTruncationNote(content)
  assert.equal(code, content)
  assert.equal(note, null)
})

test('prepareChatMessages does not hide reads without a preceding edit', () => {
  const out = prepareChatMessages([
    callTurn('read_file', 'r1', { path: 'foo.py' }),
    resultFor('r1'),
    callTurn('read_file', 'r2', { path: 'foo.py' }),
    resultFor('r2'),
  ])
  assert.equal(out.length, 4)
})
