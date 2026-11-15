import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  codexRecordEvents,
  codexSessionMeta,
  codexTitlesFromIndex,
  codexToolCall,
  patchToolCall,
  shellCommandFromArgv,
} from './chat-import-codex'

const TIME = '2026-11-14T10:00:00.000Z'
const TIME_MS = Date.parse(TIME)

function item(payload: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: TIME, type: 'response_item', payload }
}

function message(role: string, content: Array<Record<string, unknown>>): Record<string, unknown> {
  return item({ type: 'message', role, content })
}

test('session meta reads id, cwd and timestamp', () => {
  assert.deepEqual(codexSessionMeta({ type: 'session_meta', payload: { id: 'abc', cwd: '/work', timestamp: TIME } }), {
    id: 'abc',
    cwd: '/work',
    startedAt: TIME,
  })
  assert.deepEqual(codexSessionMeta({ type: 'session_meta', payload: { id: 'abc' } }), { id: 'abc', cwd: null, startedAt: null })
  assert.equal(codexSessionMeta({ type: 'response_item', payload: { id: 'abc' } }), null)
  assert.equal(codexSessionMeta({ type: 'session_meta', payload: {} }), null)
})

test('context blocks and developer messages are dropped', () => {
  const events = codexRecordEvents(
    message('user', [
      { type: 'input_text', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' },
      { type: 'input_text', text: '# AGENTS.md instructions for /work' },
      { type: 'input_text', text: 'fix it' },
    ])
  )
  assert.deepEqual(events, [{ kind: 'user', text: 'fix it', images: [], timestamp: TIME_MS }])
  assert.deepEqual(codexRecordEvents(message('user', [{ type: 'input_text', text: '<user_instructions>x</user_instructions>' }])), [])
  assert.deepEqual(codexRecordEvents(message('developer', [{ type: 'input_text', text: 'rules' }])), [])
  assert.deepEqual(codexRecordEvents(message('system', [{ type: 'input_text', text: 'rules' }])), [])
})

test('assistant text joins output blocks', () => {
  assert.deepEqual(codexRecordEvents(message('assistant', [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }])), [
    { kind: 'assistant-text', text: 'a\n\nb', timestamp: TIME_MS },
  ])
  assert.deepEqual(codexRecordEvents(message('assistant', [])), [])
})

test('user data-URL images are kept', () => {
  const events = codexRecordEvents(
    message('user', [
      { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' },
      { type: 'input_image', image_url: 'https://example.invalid/a.png' },
    ])
  )
  assert.deepEqual(events, [{ kind: 'user', text: '', images: [{ data: 'QUJD', mimeType: 'image/jpeg' }], timestamp: TIME_MS }])
})

test('reasoning and event messages are dropped', () => {
  assert.deepEqual(codexRecordEvents(item({ type: 'reasoning', summary: [], encrypted_content: 'x' })), [])
  assert.deepEqual(codexRecordEvents(item({ type: 'compaction' })), [])
  assert.deepEqual(codexRecordEvents({ timestamp: TIME, type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }), [])
  assert.deepEqual(codexRecordEvents({ timestamp: TIME, type: 'turn_context', payload: {} }), [])
})

test('function and custom tool calls become tool-call events', () => {
  assert.deepEqual(
    codexRecordEvents(item({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}', call_id: 'c1' })),
    [{ kind: 'tool-call', id: 'c1', call: codexToolCall('exec_command', '{"cmd":"pwd"}', false), timestamp: TIME_MS }]
  )
  assert.deepEqual(
    codexRecordEvents(item({ type: 'custom_tool_call', name: 'exec', input: 'print(1)', call_id: 'c2' })),
    [{ kind: 'tool-call', id: 'c2', call: { kind: 'other', sourceName: 'exec', sourceInput: 'print(1)' }, timestamp: TIME_MS }]
  )
})

test('shell calls map to shell', () => {
  assert.deepEqual(codexToolCall('shell', JSON.stringify({ command: ['bash', '-lc', 'ls -la'], timeout_ms: 1500 }), false), {
    kind: 'shell',
    command: 'ls -la',
    timeoutSeconds: 2,
    sourceName: 'shell',
    sourceInput: JSON.stringify({ command: ['bash', '-lc', 'ls -la'], timeout_ms: 1500 }),
  })
  assert.equal(shellCommandFromArgv(['git', 'commit', '-m', "it's"]), "git commit -m 'it'\\''s'")
  assert.equal(shellCommandFromArgv(['/bin/zsh', '-c', 'echo hi']), 'echo hi')
  assert.equal(shellCommandFromArgv(['ls', 'a b', 'c.txt']), "ls 'a b' c.txt")
  const container = codexToolCall('container.exec', JSON.stringify({ command: ['ls'] }), false)
  assert.deepEqual(container.kind === 'shell' && [container.command, 'timeoutSeconds' in container], ['ls', false])
  const exec = codexToolCall('exec_command', '{"cmd":"pwd"}', false)
  assert.deepEqual(exec.kind === 'shell' && exec.command, 'pwd')
  assert.equal(codexToolCall('shell', '{"command":"ls"}', false).kind, 'other')
  assert.equal(codexToolCall('shell', 'not json', false).kind, 'other')
})

const ADD_PATCH = ['*** Begin Patch', '*** Add File: src/new.ts', '+a', '+b', '*** End Patch'].join('\n')
const UPDATE_PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  ' keep',
  '-old one',
  '+new one',
  '@@ function b',
  ' line',
  '-x',
  '+y',
  '+z',
  '*** End Patch',
].join('\n')

test('apply_patch maps to write or edit', () => {
  const add = codexToolCall('apply_patch', ADD_PATCH, true)
  assert.deepEqual(add.kind === 'write' && [add.path, add.content], ['src/new.ts', 'a\nb\n'])
  assert.equal(add.sourceInput, ADD_PATCH)

  const update = patchToolCall(UPDATE_PATCH, 'apply_patch')
  assert.equal(update.kind, 'edit')
  assert.deepEqual(update.kind === 'edit' && [update.path, update.edits], [
    'src/a.ts',
    [
      { oldText: 'keep\nold one', newText: 'keep\nnew one', replaceAll: false },
      { oldText: 'line\nx', newText: 'line\ny\nz', replaceAll: false },
    ],
  ])
  const viaFunction = codexToolCall('apply_patch', JSON.stringify({ input: UPDATE_PATCH }), false)
  assert.equal(viaFunction.kind, 'edit')

  const twoFiles = ['*** Begin Patch', '*** Add File: a', '+a', '*** Add File: b', '+b', '*** End Patch'].join('\n')
  assert.equal(patchToolCall(twoFiles, 'apply_patch').kind, 'other')
  assert.equal(patchToolCall(['*** Begin Patch', '*** Delete File: a', '*** End Patch'].join('\n'), 'apply_patch').kind, 'other')
  const move = ['*** Begin Patch', '*** Update File: a', '*** Move to: b', ' x', '*** End Patch'].join('\n')
  assert.equal(patchToolCall(move, 'apply_patch').kind, 'other')
  assert.equal(patchToolCall(['*** Begin Patch', '*** Update File: a', '*** End Patch'].join('\n'), 'apply_patch').kind, 'other')
  assert.equal(patchToolCall('no patch', 'apply_patch').kind, 'other')
})

test('unknown tools stay other with raw input', () => {
  assert.deepEqual(codexToolCall('exec', 'const a = 1', true), { kind: 'other', sourceName: 'exec', sourceInput: 'const a = 1' })
  assert.deepEqual(codexToolCall('wait', '{"cell_id":"1"}', false), { kind: 'other', sourceName: 'wait', sourceInput: '{"cell_id":"1"}' })
})

test('tool outputs parse exit codes', () => {
  const output = (value: unknown): unknown =>
    codexRecordEvents(item({ type: 'function_call_output', call_id: 'c1', output: value }))
  assert.deepEqual(output('{"output":"x","metadata":{"exit_code":1}}'), [
    { kind: 'tool-result', id: 'c1', text: 'x', images: [], isError: true, timestamp: TIME_MS },
  ])
  assert.deepEqual(output('{"output":"x","metadata":{"exit_code":0}}'), [
    { kind: 'tool-result', id: 'c1', text: 'x', images: [], isError: false, timestamp: TIME_MS },
  ])
  assert.deepEqual(output('plain'), [{ kind: 'tool-result', id: 'c1', text: 'plain', images: [], isError: false, timestamp: TIME_MS }])
  assert.deepEqual(output('{"page_id":"p"}'), [{ kind: 'tool-result', id: 'c1', text: '{"page_id":"p"}', images: [], isError: false, timestamp: TIME_MS }])
  assert.deepEqual(
    codexRecordEvents(
      item({
        type: 'custom_tool_call_output',
        call_id: 'c2',
        output: [
          { type: 'input_text', text: 'a' },
          { type: 'output_text', text: 'b' },
          { type: 'input_image', image_url: 'data:image/png;base64,Zm9v' },
        ],
      })
    ),
    [{ kind: 'tool-result', id: 'c2', text: 'a\nb', images: [{ data: 'Zm9v', mimeType: 'image/png' }], isError: false, timestamp: TIME_MS }]
  )
})

test('titles come from the latest index line', () => {
  const titles = codexTitlesFromIndex([
    JSON.stringify({ id: 'a', thread_name: 'First', updated_at: TIME }),
    'not json',
    JSON.stringify({ id: 'b', thread_name: 'Other' }),
    JSON.stringify({ id: 'a', thread_name: 'Renamed', updated_at: TIME }),
    JSON.stringify({ id: 'c', thread_name: 5 }),
    '',
  ])
  assert.deepEqual([...titles], [['a', 'Renamed'], ['b', 'Other']])
})
