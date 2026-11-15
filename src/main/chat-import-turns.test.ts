import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImportTurnAssembler, toolInputText, type ImportToolCall } from './chat-import-turns'
import { isChatImportSource } from '../shared/chat-import'

const SHELL_CALL: ImportToolCall = { kind: 'shell', command: 'ls', sourceName: 'Bash', sourceInput: 'ls' }

test('assembler merges consecutive assistant events into one turn', () => {
  const assembler = new ImportTurnAssembler()
  assert.deepEqual(assembler.push({ kind: 'assistant-text', text: 'a', timestamp: 1 }), [])
  assert.deepEqual(assembler.push({ kind: 'tool-call', id: 'c1', call: SHELL_CALL, timestamp: 2 }), [])
  assert.deepEqual(assembler.push({ kind: 'assistant-text', text: 'b', timestamp: 3 }), [])
  assert.deepEqual(assembler.finish(), [
    {
      role: 'assistant',
      timestamp: 1,
      blocks: [
        { type: 'text', text: 'a' },
        { type: 'tool', id: 'c1', call: SHELL_CALL },
        { type: 'text', text: 'b' },
      ],
    },
  ])
})

test('assembler flushes the assistant turn before a tool result', () => {
  const assembler = new ImportTurnAssembler()
  assembler.push({ kind: 'tool-call', id: 'c1', call: SHELL_CALL, timestamp: 1 })
  const turns = assembler.push({ kind: 'tool-result', id: 'c1', text: 'out', images: [], isError: false, timestamp: 2 })
  assert.equal(turns.length, 2)
  assert.equal(turns[0].role, 'assistant')
  assert.deepEqual(turns[1], { role: 'tool-result', id: 'c1', call: SHELL_CALL, text: 'out', images: [], isError: false, timestamp: 2 })
  assert.deepEqual(assembler.finish(), [])
})

test('assembler gives a result with no known call a null call', () => {
  const assembler = new ImportTurnAssembler()
  const [turn] = assembler.push({ kind: 'tool-result', id: 'zz', text: '', images: [], isError: false, timestamp: 1 })
  assert.equal(turn.role, 'tool-result')
  assert.equal(turn.role === 'tool-result' && turn.call, null)
})

test('assembler flushes before a user event and on finish', () => {
  const assembler = new ImportTurnAssembler()
  assembler.push({ kind: 'assistant-text', text: 'a', timestamp: 1 })
  const turns = assembler.push({ kind: 'user', text: 'u', images: [], timestamp: 2 })
  assert.deepEqual(turns.map((turn) => turn.role), ['assistant', 'user'])
  assembler.push({ kind: 'assistant-text', text: 'b', timestamp: 3 })
  assert.deepEqual(assembler.finish().map((turn) => turn.role), ['assistant'])
  assert.deepEqual(assembler.finish(), [])
})

test('toolInputText keeps strings and pretty-prints objects', () => {
  assert.equal(toolInputText('x'), 'x')
  assert.equal(toolInputText({ a: 1 }), '{\n  "a": 1\n}')
})

test('isChatImportSource accepts only the two sources', () => {
  assert.equal(isChatImportSource('claude-code'), true)
  assert.equal(isChatImportSource('codex'), true)
  assert.equal(isChatImportSource('pi'), false)
  assert.equal(isChatImportSource(undefined), false)
  assert.equal(isChatImportSource('toString'), false)
})
