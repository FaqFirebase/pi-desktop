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

test('group title counts distinct targets: same file read twice reads as one', () => {
  const items = groupToolMessages([
    toolTurn('read_file', { path: 'src/app/foo.ts' }),
    result(),
    toolTurn('read_file', { path: 'src/app/foo.ts' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Read a file'])
})

test('group title counts distinct targets: same URL fetched thrice reads as one', () => {
  const items = groupToolMessages([
    toolTurn('web_fetch', { url: 'https://cnn.com' }),
    result(),
    toolTurn('web_fetch', { url: 'https://cnn.com' }),
    result(),
    toolTurn('web_fetch', { url: 'https://cnn.com' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Fetched a URL'])
})

test('group title counts same-named files in different dirs as distinct', () => {
  const items = groupToolMessages([
    toolTurn('read_file', { path: 'a/foo.ts' }),
    result(),
    toolTurn('read_file', { path: 'b/foo.ts' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Read 2 files'])
})

test('group title dedupes paths across separators and case', () => {
  const items = groupToolMessages([
    toolTurn('read_file', { path: 'C:\\work\\Foo.ts' }),
    result(),
    toolTurn('read_file', { path: 'c:/work/foo.ts' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Read a file'])
})

test('group title dedupes per target in a mixed run', () => {
  const items = groupToolMessages([
    toolTurn('web_fetch', { url: 'https://x.com' }),
    result(),
    toolTurn('web_fetch', { url: 'https://x.com' }),
    result(),
    toolTurn('read_file', { path: 'a.ts' }),
    result(),
    toolTurn('read_file', { path: 'b.ts' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Fetched a URL, read 2 files'])
})

test('group title still counts target-less commands individually', () => {
  const items = groupToolMessages([
    toolTurn('bash', { command: 'ls' }),
    result(),
    toolTurn('bash', { command: 'ls' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Ran 2 commands'])
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

test('prepareChatMessages keeps every read, including a re-read of the same file', () => {
  const out = prepareChatMessages([
    callTurn('edit_file', 'e1', { path: 'C:/work/btc.py', edits: [{ oldText: 'a', newText: 'b' }] }),
    resultFor('e1', 'Successfully replaced 1 block'),
    callTurn('read_file', 'r1', { path: 'btc.py' }), // same file re-read -> still shown
    resultFor('r1', 'file body'),
  ])
  const ids = out.map((m) => m.id)
  assert.ok(ids.includes('r1-result'), 're-read result kept')
  assert.ok(out.some((m) => m.toolCalls?.some((tc) => tc.id === 'r1')), 're-read call kept')
  assert.equal(out.length, 4)
})

test('prepareChatMessages splits a prose+tools turn so its tool call can group', () => {
  const mixed = assistant({
    id: 'm1',
    content: 'Now let me pick two articles',
    model: 'ornith',
    provider: 'lmstudio',
    cost: 0.01,
    thinking: 'reasoning',
    toolCalls: [{ id: 'c1', name: 'web_fetch', arguments: '{"url":"https://x.com/a"}' }],
  })
  const out = prepareChatMessages([
    mixed,
    resultFor('c1'),
    callTurn('web_fetch', 'c2', { url: 'https://x.com/b' }),
    resultFor('c2'),
  ])

  // The mixed turn becomes: prose-only (keeps id/content/thinking/cost) + a
  // tool-only half (derived id, no prose bits, keeps model for the group header).
  const prosePart = out[0]
  assert.equal(prosePart.id, 'm1')
  assert.equal(prosePart.content, 'Now let me pick two articles')
  assert.equal(prosePart.thinking, 'reasoning')
  assert.equal(prosePart.toolCalls, undefined)

  const toolPart = out[1]
  assert.equal(toolPart.id, 'm1::tools')
  assert.equal(toolPart.content, '')
  assert.equal(toolPart.thinking, undefined)
  assert.equal(toolPart.cost, undefined)
  assert.equal(toolPart.model, 'ornith')
  assert.equal(toolPart.toolCalls?.[0].id, 'c1')

  // After grouping, the split tool call joins the second fetch into one group.
  const items = groupToolMessages(out)
  assert.deepEqual(titles(items), ['Fetched 2 URLs'])
  assert.equal(items[0].kind, 'message') // the prose renders on its own first
  assert.equal(items[1].kind, 'toolGroup')
})

test('prepareChatMessages leaves a pure-prose or pure-tool turn as the same object', () => {
  const p = prose('just text')
  const t = toolTurn('web_fetch', { url: 'https://x.com' })
  const out = prepareChatMessages([p, t])
  assert.equal(out[0], p) // same ref — nothing to split
  assert.equal(out[1], t)
})
