import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeCodeScanner, claudeCodeRecordEvents, claudeCodeToolCall, stripClaudeCodeNoise } from './chat-import-claude-code'

const TIME = '2026-11-14T10:00:00.000Z'
const TIME_MS = Date.parse(TIME)

type Fields = Record<string, unknown>

function record(type: string, uuid: string, parentUuid: string | null, fields: Fields = {}): Fields {
  return { type, uuid, parentUuid, isSidechain: false, sessionId: 's', timestamp: TIME, ...fields }
}

function userText(uuid: string, parentUuid: string | null, text: string, fields: Fields = {}): Fields {
  return record('user', uuid, parentUuid, { message: { role: 'user', content: text }, ...fields })
}

function toolUse(uuid: string, parentUuid: string | null, id: string): Fields {
  return record('assistant', uuid, parentUuid, {
    message: { id: 'msg', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] },
  })
}

function toolResult(uuid: string, parentUuid: string | null, id: string): Fields {
  return record('user', uuid, parentUuid, {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'out' }] },
  })
}

function scan(records: Fields[]): ReturnType<ClaudeCodeScanner['result']> {
  const scanner = new ClaudeCodeScanner()
  records.forEach((entry, line) => scanner.add(entry, line))
  return scanner.result()
}

function keptUuids(records: Fields[]): string[] {
  const { keptLines } = scan(records)
  return records.filter((_, line) => keptLines.has(line)).map((entry) => entry.uuid as string)
}

test('scanner keeps the active branch and sibling tool results', () => {
  const records = [
    userText('u1', null, 'start'),
    record('assistant', 'x1', 'u1', { message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] } }),
    toolUse('a1', 'u1', 't1'),
    toolUse('a2', 'a1', 't2'),
    toolResult('r1', 'a1', 't1'),
    toolResult('r2', 'a2', 't2'),
    record('assistant', 'a3', 'r2', { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    { type: 'last-prompt', lastPrompt: 'x' },
  ]
  assert.deepEqual(keptUuids(records), ['u1', 'a1', 'a2', 'r1', 'r2', 'a3'])
})

test('scanner bridges a compact boundary', () => {
  const records = [
    userText('u1', null, 'start'),
    record('assistant', 'a1', 'u1', { message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } }),
    record('system', 's', null, { subtype: 'compact_boundary', logicalParentUuid: 'a1' }),
    userText('u2', 's', 'again'),
    record('assistant', 'leaf', 'u2', { message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } }),
  ]
  assert.deepEqual(keptUuids(records), ['u1', 'a1', 's', 'u2', 'leaf'])
})

test('scanner skips sidechains and reads title and cwd', () => {
  const records = [
    { type: 'ai-title', aiTitle: ' Auto title ' },
    userText('u1', null, 'start', { cwd: '/work/one', timestamp: '2026-11-14T09:00:00.000Z' }),
    userText('u2', 'u1', 'next', { cwd: '/work/two' }),
    { type: 'custom-title', customTitle: 'Named' },
    { type: 'ai-title', aiTitle: 'Later auto title' },
    userText('side', 'u2', 'sidechain', { isSidechain: true }),
  ]
  const result = scan(records)
  assert.equal(result.title, 'Named')
  assert.equal(result.cwd, '/work/one')
  assert.equal(result.startedAt, '2026-11-14T09:00:00.000Z')
  assert.deepEqual(keptUuids(records), ['u1', 'u2'])
  assert.equal(scan([{ type: 'ai-title', aiTitle: 'Auto' }, { type: 'custom-title', customTitle: '  ' }]).title, 'Auto')
  assert.equal(scan([]).title, null)
})

test('stripClaudeCodeNoise removes tool and IDE tags with their content', () => {
  assert.equal(stripClaudeCodeNoise('<system-reminder>\nx\n</system-reminder>hello <ide_selection a="1">sel</ide_selection>'), 'hello')
  assert.equal(stripClaudeCodeNoise('<command-name>/clear</command-name>'), '')
})

test('user text loses noise tags', () => {
  assert.deepEqual(claudeCodeRecordEvents(userText('u', null, '<system-reminder>x</system-reminder>hello')), [
    { kind: 'user', text: 'hello', images: [], timestamp: TIME_MS },
  ])
  assert.deepEqual(claudeCodeRecordEvents(userText('u', null, '<command-name>/clear</command-name>')), [])
  const blocks = record('user', 'u', null, {
    message: { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: '<ide_opened_file>f</ide_opened_file>' }, { type: 'text', text: 'two' }] },
  })
  assert.deepEqual(claudeCodeRecordEvents(blocks), [{ kind: 'user', text: 'one\n\ntwo', images: [], timestamp: TIME_MS }])
})

test('user images are kept', () => {
  const events = claudeCodeRecordEvents(
    record('user', 'u', null, {
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } },
        ],
      },
    })
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'user')
  assert.deepEqual(events[0].kind === 'user' && events[0].images, [{ data: 'QUJD', mimeType: 'image/png' }])
})

test('tool results come out with text, images and error flag', () => {
  const events = claudeCodeRecordEvents(
    record('user', 'u', null, {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'and this' },
          { type: 'tool_result', tool_use_id: 't1', content: 'plain' },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            is_error: true,
            content: [
              { type: 'text', text: 'a' },
              { type: 'tool_reference', tool_name: 'x' },
              { type: 'text', text: 'b' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Zm9v' } },
            ],
          },
        ],
      },
    })
  )
  assert.deepEqual(events, [
    { kind: 'tool-result', id: 't1', text: 'plain', images: [], isError: false, timestamp: TIME_MS },
    { kind: 'tool-result', id: 't2', text: 'a\nb', images: [{ data: 'Zm9v', mimeType: 'image/jpeg' }], isError: true, timestamp: TIME_MS },
    { kind: 'user', text: 'and this', images: [], timestamp: TIME_MS },
  ])
})

test('assistant thinking and synthetic messages are dropped', () => {
  const events = claudeCodeRecordEvents(
    record('assistant', 'a', null, {
      message: {
        role: 'assistant',
        model: 'm',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'redacted_thinking', data: 'x' },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.ts', content: 'x' } },
          { type: 'server_tool_use', id: 's1' },
        ],
      },
    })
  )
  assert.deepEqual(events.map((event) => event.kind), ['assistant-text', 'tool-call'])
  assert.deepEqual(
    claudeCodeRecordEvents(record('assistant', 'a', null, { message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API error' }] } })),
    []
  )
})

test('queued prompts become user turns', () => {
  assert.deepEqual(
    claudeCodeRecordEvents(record('attachment', 'q', null, { attachment: { type: 'queued_command', prompt: 'do more' } })),
    [{ kind: 'user', text: 'do more', images: [], timestamp: TIME_MS }]
  )
  assert.deepEqual(claudeCodeRecordEvents(record('attachment', 'q', null, { attachment: { type: 'hook_success', content: 'x' } })), [])
})

test('meta records yield nothing', () => {
  assert.deepEqual(claudeCodeRecordEvents(userText('m', null, 'skill body', { isMeta: true })), [])
  assert.deepEqual(claudeCodeRecordEvents(userText('s', null, 'side', { isSidechain: true })), [])
  assert.deepEqual(claudeCodeRecordEvents(record('system', 's', null, { subtype: 'compact_boundary' })), [])
})

test('tool calls map by name', () => {
  assert.deepEqual(claudeCodeToolCall('Bash', { command: 'ls', timeout: 120000 }), {
    kind: 'shell',
    command: 'ls',
    timeoutSeconds: 120,
    sourceName: 'Bash',
    sourceInput: '{\n  "command": "ls",\n  "timeout": 120000\n}',
  })
  assert.equal('timeoutSeconds' in claudeCodeToolCall('Bash', { command: 'ls' }), false)
  assert.deepEqual(
    (({ sourceInput: _, ...rest }) => rest)(claudeCodeToolCall('Read', { file_path: 'a.ts', offset: 3, limit: 4 })),
    { kind: 'read', path: 'a.ts', offset: 3, limit: 4, sourceName: 'Read' }
  )
  const edit = claudeCodeToolCall('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b', replace_all: true })
  assert.equal(edit.kind, 'edit')
  assert.deepEqual(edit.kind === 'edit' && edit.edits, [{ oldText: 'a', newText: 'b', replaceAll: true }])
  const multi = claudeCodeToolCall('MultiEdit', {
    file_path: 'a.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd', replace_all: true },
    ],
  })
  assert.deepEqual(multi.kind === 'edit' && multi.edits, [
    { oldText: 'a', newText: 'b', replaceAll: false },
    { oldText: 'c', newText: 'd', replaceAll: true },
  ])
  const write = claudeCodeToolCall('Write', { file_path: 'a.ts', content: 'x' })
  assert.deepEqual(write.kind === 'write' && [write.path, write.content], ['a.ts', 'x'])
  assert.deepEqual(claudeCodeToolCall('Grep', { pattern: 'x' }), { kind: 'other', sourceName: 'Grep', sourceInput: '{\n  "pattern": "x"\n}' })
  assert.equal(claudeCodeToolCall('Bash', { command: 5 }).kind, 'other')
  assert.equal(claudeCodeToolCall('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 1 }] }).kind, 'other')
})
