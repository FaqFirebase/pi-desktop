import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreStoppedAnswers, stoppedAnswersOnBranch, withStoppedAnswers } from './omp-stopped-answers'

// Shaped like an OMP 18 session file: a tool turn, then an answer the user
// stopped, then the exit record OMP appends on shutdown. An abandoned branch
// (entry "b0") holds another stopped answer that must stay hidden.
const USER = { role: 'user', content: [{ type: 'text', text: 'List the files, then write an essay.' }], timestamp: 1_000 }
const TOOL_CALL = {
  role: 'assistant', stopReason: 'toolUse', timestamp: 2_000,
  content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '.' } }],
}
const TOOL_RESULT = { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: 'readme.txt' }], timestamp: 3_000 }
const STOPPED = {
  role: 'assistant', stopReason: 'aborted', errorMessage: 'Interrupted by user', timestamp: 4_000,
  content: [{ type: 'text', text: 'Done.\n\n**Folder listing**' }],
}
const ABANDONED = { ...STOPPED, timestamp: 2_500, content: [{ type: 'text', text: 'abandoned branch' }] }

const SESSION_FILE = [
  { type: 'title', v: 1, title: '' },
  { type: 'session', version: 3, id: '01a0f1d5-1cf6-76ac-9aa9-48ff79d9998e', cwd: '/work/demo' },
  { type: 'model_change', id: 'm0', parentId: null, model: 'opencode-go/deepseek-v4.1-flash' },
  { type: 'message', id: 'u1', parentId: 'm0', message: USER },
  { type: 'message', id: 'b0', parentId: 'u1', message: ABANDONED },
  { type: 'message', id: 'a1', parentId: 'u1', message: TOOL_CALL },
  { type: 'custom', customType: 'tool_execution_start', id: 'c1', parentId: 'a1', data: { toolCallId: 'call_1' } },
  { type: 'message', id: 't1', parentId: 'c1', message: TOOL_RESULT },
  { type: 'message', id: 's1', parentId: 't1', message: STOPPED },
  { type: 'custom', customType: 'session_exit', id: 'x1', parentId: 's1', data: { reason: 'sigterm' } },
].map((entry) => JSON.stringify(entry)).join('\n') + '\n'

/** What `get_messages` returns after OMP reloaded the file: the stopped answer is missing. */
const RELOADED_MESSAGES = [USER, TOOL_CALL, TOOL_RESULT]

test('the stopped answers on the current branch are read from an OMP session file', () => {
  assert.deepEqual(stoppedAnswersOnBranch(SESSION_FILE), [STOPPED])
  assert.deepEqual(stoppedAnswersOnBranch('not json\n{"type":"title"}\n'), [])
})

test('a missing stopped answer goes back in time order, once', () => {
  assert.deepEqual(restoreStoppedAnswers(RELOADED_MESSAGES, [STOPPED]), [...RELOADED_MESSAGES, STOPPED])
  const midTurn = { ...STOPPED, timestamp: 2_500 }
  assert.deepEqual(restoreStoppedAnswers(RELOADED_MESSAGES, [midTurn]), [USER, TOOL_CALL, midTurn, TOOL_RESULT])
  // The live runtime still has it: nothing is added.
  assert.deepEqual(restoreStoppedAnswers([...RELOADED_MESSAGES, STOPPED], [STOPPED]), [...RELOADED_MESSAGES, STOPPED])
  // Older than the first message sent (trimmed history): stays out.
  assert.deepEqual(restoreStoppedAnswers([TOOL_RESULT], [{ ...STOPPED, timestamp: 500 }]), [TOOL_RESULT])
})

test('a reloaded OMP get_messages response gets its stopped answer back from the session file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-omp-stopped-'))
  try {
    const sessionPath = join(dir, 'session.jsonl')
    await writeFile(sessionPath, SESSION_FILE)
    const response = { type: 'response', command: 'get_messages', success: true, data: { messages: RELOADED_MESSAGES } }
    const restored = await withStoppedAnswers(response, sessionPath) as typeof response
    assert.deepEqual(restored.data.messages, [...RELOADED_MESSAGES, STOPPED])
    assert.equal(restored.success, true)
    assert.equal(await withStoppedAnswers(response, join(dir, 'missing.jsonl')), response)
    assert.equal(await withStoppedAnswers(null, sessionPath), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
