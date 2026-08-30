import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { forkPointFromLine, readForkPoints } from './omp-fork-points'

// Mirrors the OMP v3 session record shapes.

const titleLine = JSON.stringify({ type: 'title', v: 1, title: '', pad: ' '.repeat(40) })
const headerLine = JSON.stringify({ type: 'session', version: 3, id: 'abc', cwd: '/p' })

const userEntry = (id: string, text: string): string =>
  JSON.stringify({
    type: 'message',
    id,
    parentId: 'p0',
    timestamp: '2026-08-24T20:05:17.716Z',
    message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user' },
  })

const assistantEntry = (id: string): string =>
  JSON.stringify({
    type: 'message',
    id,
    parentId: 'p1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
  })

const toolResultEntry = (id: string): string =>
  JSON.stringify({
    type: 'message',
    id,
    parentId: 'p2',
    message: { role: 'toolResult', content: [{ type: 'text', text: 'output' }] },
  })

test('forkPointFromLine extracts a user message entry', () => {
  assert.deepEqual(forkPointFromLine(userEntry('41e43649', 'create a test.md file')), {
    entryId: '41e43649',
    text: 'create a test.md file',
  })
})

test('forkPointFromLine ignores non-user and malformed records', () => {
  assert.equal(forkPointFromLine(assistantEntry('04b37a9d')), null)
  assert.equal(forkPointFromLine(toolResultEntry('a1b2c3d4')), null)
  assert.equal(forkPointFromLine(titleLine), null)
  assert.equal(forkPointFromLine(headerLine), null)
  assert.equal(forkPointFromLine(''), null)
  assert.equal(forkPointFromLine('not json'), null)
})

test('forkPointFromLine drops user entries without an id', () => {
  const noId = JSON.stringify({
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  })
  assert.equal(forkPointFromLine(noId), null)
})

test('readForkPoints returns user messages in file order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-fork-points-'))
  try {
    const path = join(dir, 'session.jsonl')
    const lines = [
      titleLine,
      headerLine,
      userEntry('aaaa1111', 'first prompt'),
      assistantEntry('bbbb2222'),
      toolResultEntry('cccc3333'),
      userEntry('dddd4444', 'second prompt'),
    ]
    await writeFile(path, `${lines.join('\n')}\n`, 'utf-8')
    assert.deepEqual(await readForkPoints(path), [
      { entryId: 'aaaa1111', text: 'first prompt' },
      { entryId: 'dddd4444', text: 'second prompt' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readForkPoints returns [] for a missing file', async () => {
  assert.deepEqual(await readForkPoints('/nonexistent/session.jsonl'), [])
})
