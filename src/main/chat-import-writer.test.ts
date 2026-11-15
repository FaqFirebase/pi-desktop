import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEngineKind } from '../shared/ipc-contracts'
import {
  OMP_TITLE_SLOT_BYTES,
  createSessionRecordWriter,
  ompTitleSlotLine,
  sessionFileName,
  type ImportSessionHeader,
} from './chat-import-writer'
import type { ImportAssistantBlock, ImportToolCall, ImportTurn } from './chat-import-turns'

/** Parsed session records, read loosely by the assertions (JSON.parse's own result type). */
type Row = Record<string, ReturnType<typeof JSON.parse>>

const HEADER: ImportSessionHeader = {
  sessionId: 'session-1',
  cwd: '/work/project',
  startedAt: '2026-11-14T10:00:00.000Z',
  title: 'T',
  writtenAt: '2026-11-14T12:00:00.000Z',
}

const SHELL: ImportToolCall = { kind: 'shell', command: 'ls', timeoutSeconds: 30, sourceName: 'Bash', sourceInput: 'ls' }

function user(text: string, images: Array<{ data: string; mimeType: string }> = []): ImportTurn {
  return { role: 'user', text, images, timestamp: 1000 }
}

function assistant(...blocks: ImportAssistantBlock[]): ImportTurn {
  return { role: 'assistant', blocks, timestamp: 2000 }
}

function tool(id: string, call: ImportToolCall): ImportAssistantBlock {
  return { type: 'tool', id, call }
}

function result(id: string, call: ImportToolCall | null, text = 'out', isError = false, images: Array<{ data: string; mimeType: string }> = []): ImportTurn {
  return { role: 'tool-result', id, call, text, images, isError, timestamp: 3000 }
}

/** Every line the writer produces for `turns`, parsed. */
function write(engine: AgentEngineKind, turns: ImportTurn[], header: ImportSessionHeader = HEADER): Row[] {
  const writer = createSessionRecordWriter(engine, header)
  const lines = [...writer.preamble(), ...turns.flatMap((turn) => writer.appendTurn(turn)), ...writer.finish()]
  return lines.map((line) => JSON.parse(line) as Row)
}

function messages(rows: Row[]): Row[] {
  return rows.filter((row) => row.type === 'message').map((row) => row.message)
}

function firstText(message: Row): string {
  return message.content.find((block: Row) => block.type === 'text').text
}

test('Pi preamble is header then session_info', () => {
  const rows = write('pi', [])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { type: 'session', version: 3, id: 'session-1', timestamp: HEADER.startedAt, cwd: '/work/project' })
  assert.equal(rows[1].type, 'session_info')
  assert.equal(rows[1].parentId, null)
  assert.equal(rows[1].name, 'T')
  assert.match(rows[1].id, /^[0-9a-f]{8}$/)
  assert.deepEqual(write('pi', [], { ...HEADER, title: null }).map((row) => row.type), ['session'])
})

test('OMP preamble starts with the title slot', () => {
  const writer = createSessionRecordWriter('omp', HEADER)
  const lines = writer.preamble()
  assert.equal(Buffer.byteLength(lines[0] + '\n'), OMP_TITLE_SLOT_BYTES)
  const slot = JSON.parse(lines[0]) as Row
  assert.deepEqual(Object.keys(slot), ['type', 'v', 'title', 'source', 'updatedAt', 'pad'])
  assert.equal(slot.type, 'title')
  assert.equal(slot.v, 1)
  assert.equal(slot.title, 'T')
  assert.equal(slot.source, 'user')
  assert.equal(slot.updatedAt, HEADER.writtenAt)
  assert.equal(JSON.parse(lines[1]).type, 'session')
  const all = [...lines, ...writer.appendTurn(user('hi'))].map((line) => JSON.parse(line) as Row)
  assert.equal(all.some((row) => row.type === 'session_info'), false)
})

test('OMP title slot is 256 bytes for a long multi-byte title', () => {
  const title = 'é漢'.repeat(150)
  const line = ompTitleSlotLine(title, HEADER.writtenAt)
  assert.equal(Buffer.byteLength(line + '\n'), OMP_TITLE_SLOT_BYTES)
  const slot = JSON.parse(line) as Row
  assert.ok(slot.title.length > 0)
  assert.ok(title.startsWith(slot.title))
  assert.match(slot.pad, /^ *$/)

  const empty = JSON.parse(ompTitleSlotLine(null, HEADER.writtenAt)) as Row
  assert.equal(empty.title, '')
  assert.equal('source' in empty, false)
  assert.equal(Buffer.byteLength(ompTitleSlotLine(null, HEADER.writtenAt) + '\n'), OMP_TITLE_SLOT_BYTES)
})

test('records chain by parentId', () => {
  for (const engine of ['pi', 'omp'] as const) {
    const rows = write(engine, [user('hi'), assistant({ type: 'text', text: 'hello' })])
    const entries = rows.filter((row) => row.type !== 'session' && row.type !== 'title')
    assert.equal(entries[0].parentId, null)
    for (let index = 1; index < entries.length; index++) {
      assert.equal(entries[index].parentId, entries[index - 1].id)
    }
    const ids = entries.map((entry) => entry.id)
    assert.ok(ids.every((id) => /^[0-9a-f]{8}$/.test(id)))
    assert.equal(new Set(ids).size, ids.length)
  }
})

test('records carry ISO and epoch timestamps', () => {
  const [row] = write('pi', [user('hi')], { ...HEADER, title: null }).filter((entry) => entry.type === 'message')
  assert.equal(row.timestamp, new Date(1000).toISOString())
  assert.equal(row.message.timestamp, 1000)
})

test('assistant messages carry the import markers and zero usage', () => {
  const [withTool, textOnly] = messages(
    write('pi', [assistant({ type: 'text', text: 'a' }, tool('c1', SHELL)), user('next'), assistant({ type: 'text', text: 'b' })])
  ).filter((message) => message.role === 'assistant')
  for (const message of [withTool, textOnly]) {
    assert.equal(message.api, 'pi-desktop-import')
    assert.equal(message.provider, 'pi-desktop-import')
    assert.equal(message.model, '<synthetic>')
    assert.equal(message.usage.totalTokens, 0)
    assert.equal(message.usage.cost.total, 0)
  }
  assert.equal(withTool.stopReason, 'toolUse')
  assert.equal(textOnly.stopReason, 'stop')
  assert.deepEqual(write('pi', [assistant()], { ...HEADER, title: null }).length, 1)
})

test('user images and OMP attribution', () => {
  const image = { data: 'QUJD', mimeType: 'image/png' }
  const [piUser] = messages(write('pi', [user('look', [image])]))
  assert.deepEqual(piUser.content, [{ type: 'text', text: 'look' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }])
  assert.equal('attribution' in piUser, false)
  const [ompUser] = messages(write('omp', [user('look', [image])]))
  assert.equal(ompUser.attribution, 'user')
  const [imageOnly] = messages(write('pi', [user('', [image])]))
  assert.deepEqual(imageOnly.content.map((block: Row) => block.type), ['image'])
})

function toolCallOf(engine: AgentEngineKind, call: ImportToolCall): Row {
  const [message] = messages(write(engine, [assistant(tool('c1', call))]))
  return message.content[0]
}

test('tools map to each engine built-ins', () => {
  for (const engine of ['pi', 'omp'] as const) {
    const bash = toolCallOf(engine, SHELL)
    assert.equal(bash.type, 'toolCall')
    assert.equal(bash.name, 'bash')
    assert.deepEqual(bash.arguments, { command: 'ls', timeout: 30 })
    const writeCall = toolCallOf(engine, { kind: 'write', path: 'a.ts', content: 'x', sourceName: 'Write', sourceInput: '' })
    assert.deepEqual([writeCall.name, writeCall.arguments], ['write', { path: 'a.ts', content: 'x' }])
  }

  const read = { kind: 'read', path: 'a.ts', offset: 5, limit: 10, sourceName: 'Read', sourceInput: '' } as const
  assert.deepEqual(toolCallOf('pi', read).arguments, { path: 'a.ts', offset: 5, limit: 10 })
  assert.deepEqual(toolCallOf('omp', read).arguments, { path: 'a.ts:5+10' })
  assert.deepEqual(toolCallOf('omp', { ...read, limit: undefined }).arguments, { path: 'a.ts:5-' })
  assert.deepEqual(toolCallOf('omp', { ...read, offset: undefined }).arguments, { path: 'a.ts:1+10' })
  assert.deepEqual(toolCallOf('omp', { ...read, offset: undefined, limit: undefined }).arguments, { path: 'a.ts' })

  const twoEdits: ImportToolCall = {
    kind: 'edit',
    path: 'a.ts',
    edits: [
      { oldText: 'a', newText: 'b', replaceAll: false },
      { oldText: 'c', newText: 'd', replaceAll: false },
    ],
    sourceName: 'MultiEdit',
    sourceInput: '{}',
  }
  const piEdit = toolCallOf('pi', twoEdits)
  assert.equal(piEdit.name, 'edit')
  assert.deepEqual(piEdit.arguments, { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] })
  assert.equal(toolCallOf('omp', twoEdits).type, 'text')
  assert.ok(toolCallOf('omp', twoEdits).text.startsWith('[Imported tool call: MultiEdit]'))

  const replaceAll: ImportToolCall = { ...twoEdits, sourceName: 'Edit', edits: [{ oldText: 'a', newText: 'b', replaceAll: true }] }
  assert.equal(toolCallOf('pi', replaceAll).type, 'text')
  assert.deepEqual(toolCallOf('omp', replaceAll).arguments, { path: 'a.ts', old_string: 'a', new_string: 'b', replace_all: true })
  const single: ImportToolCall = { ...replaceAll, edits: [{ oldText: 'a', newText: 'b', replaceAll: false }] }
  assert.deepEqual(toolCallOf('omp', single).arguments, { path: 'a.ts', old_string: 'a', new_string: 'b' })
})

test('unknown tools become text with their result', () => {
  const grep: ImportToolCall = { kind: 'other', sourceName: 'Grep', sourceInput: '{"pattern":"x"}' }
  const rows = write('pi', [assistant(tool('g1', grep)), result('g1', grep, 'found', true, [{ data: 'a', mimeType: 'image/png' }])])
  const [call, answer] = messages(rows)
  assert.equal(call.role, 'assistant')
  assert.equal(call.stopReason, 'stop')
  assert.equal(firstText(call), '[Imported tool call: Grep]\n```\n{"pattern":"x"}\n```')
  assert.equal(answer.role, 'assistant')
  assert.equal(firstText(answer), '[Imported tool result: Grep (error)]\n```\nfound\n```\n(1 image(s) not imported)')
  assert.equal(rows.some((row) => row.message?.role === 'toolResult'), false)
})

test('writer turns a late tool result into text', () => {
  const afterUser = messages(write('pi', [assistant(tool('c1', SHELL)), user('stop'), result('c1', SHELL)]))
  assert.equal(afterUser.at(-1)!.role, 'assistant')
  assert.ok(firstText(afterUser.at(-1)!).startsWith('[Imported tool result: Bash]'))

  const afterAssistant = messages(
    write('pi', [assistant(tool('c1', SHELL)), assistant(tool('c2', SHELL)), result('c1', SHELL)])
  )
  assert.equal(afterAssistant.at(-1)!.role, 'assistant')
  assert.equal(afterAssistant.some((message) => message.role === 'toolResult'), false)

  const orphan = messages(write('pi', [result('zz', null)]))
  assert.ok(firstText(orphan[0]).startsWith('[Imported tool result: unknown]'))

  const twice = messages(write('pi', [assistant(tool('c1', SHELL)), result('c1', SHELL), result('c1', SHELL)]))
  assert.deepEqual(twice.map((message) => message.role), ['assistant', 'toolResult', 'assistant'])
})

test('tool results pair with their call', () => {
  const [call, answer] = messages(write('omp', [assistant(tool('toolu|01', SHELL)), result('toolu|01', SHELL, 'done', false, [{ data: 'a', mimeType: 'image/png' }])]))
  assert.equal(call.content[0].id, 'toolu_01')
  assert.equal(answer.role, 'toolResult')
  assert.equal(answer.toolCallId, 'toolu_01')
  assert.equal(answer.toolName, 'bash')
  assert.equal(answer.isError, false)
  assert.deepEqual(answer.content, [{ type: 'text', text: 'done' }, { type: 'image', data: 'a', mimeType: 'image/png' }])
})

test('tool call ids are cut and kept unique', () => {
  const longId = 'x'.repeat(100)
  const [message] = messages(write('pi', [assistant(tool('a|b', SHELL), tool('a_b', SHELL), tool(longId, SHELL))]))
  const ids = message.content.map((block: Row) => block.id)
  assert.equal(ids[0], 'a_b')
  assert.equal(ids[1], 'a_b_2')
  assert.equal(ids[2].length, 64)
})

test('fence grows past backtick runs in content', () => {
  const other: ImportToolCall = { kind: 'other', sourceName: 'X', sourceInput: 'a ``` b' }
  const [message] = messages(write('pi', [assistant(tool('x', other))]))
  assert.equal(firstText(message), '[Imported tool call: X]\n````\na ``` b\n````')
})

test('sessionFileName replaces colons and dots', () => {
  assert.equal(sessionFileName('2026-11-14T10:20:30.400Z', 'abc'), '2026-11-14T10-20-30-400Z_abc.jsonl')
})

test('messageCount counts message records only', () => {
  const writer = createSessionRecordWriter('pi', HEADER)
  writer.preamble()
  assert.equal(writer.messageCount, 0)
  writer.appendTurn(user('hi'))
  writer.appendTurn(assistant())
  writer.appendTurn(assistant({ type: 'text', text: 'a' }))
  assert.equal(writer.messageCount, 2)
})

test('a turn with no readable time reuses the last time', () => {
  const rows = messages(write('pi', [{ role: 'user', text: 'a', images: [], timestamp: Number.NaN }, user('b'), { role: 'user', text: 'c', images: [], timestamp: Number.NaN }]))
  assert.deepEqual(rows.map((message) => message.timestamp), [Date.parse(HEADER.startedAt), 1000, 1000])
})

test('a fallback result in a parallel batch waits for the open calls', () => {
  const grep: ImportToolCall = { kind: 'other', sourceName: 'Grep', sourceInput: 'x' }
  const ordered = messages(write('pi', [assistant(tool('g1', grep), tool('b1', SHELL)), result('g1', grep, 'found'), result('b1', SHELL, 'done'), user('next')]))
  assert.deepEqual(ordered.map((message) => message.role), ['assistant', 'toolResult', 'assistant', 'user'])
  assert.equal(ordered[1].toolCallId, 'b1')
  assert.ok(firstText(ordered[2]).startsWith('[Imported tool result: Grep]'))

  const two: ImportToolCall = { kind: 'other', sourceName: 'Glob', sourceInput: 'y' }
  const merged = messages(write('pi', [assistant(tool('g1', grep), tool('g2', two), tool('b1', SHELL)), result('g1', grep), result('g2', two), result('b1', SHELL)]))
  assert.deepEqual(merged.map((message) => message.role), ['assistant', 'toolResult', 'assistant'])
  assert.equal(merged[2].content.length, 2)
})

test('held fallback results are written before the next turn and at finish', () => {
  const grep: ImportToolCall = { kind: 'other', sourceName: 'Grep', sourceInput: 'x' }
  const beforeUser = messages(write('pi', [assistant(tool('g1', grep), tool('b1', SHELL)), result('g1', grep), user('stop')]))
  assert.deepEqual(beforeUser.map((message) => message.role), ['assistant', 'assistant', 'user'])

  const writer = createSessionRecordWriter('pi', { ...HEADER, title: null })
  writer.preamble()
  writer.appendTurn(assistant(tool('g1', grep), tool('b1', SHELL)))
  assert.deepEqual(writer.appendTurn(result('g1', grep)), [])
  const [held] = writer.finish().map((line) => JSON.parse(line) as Row)
  assert.ok(firstText(held.message).startsWith('[Imported tool result: Grep]'))
  assert.deepEqual(writer.finish(), [])
  assert.equal(writer.messageCount, 2)
})
