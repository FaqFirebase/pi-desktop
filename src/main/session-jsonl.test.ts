import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSONL_STREAM_YIELD_LINES, parseSessionLines, readSessionEntries, streamJsonlRecords } from './session-jsonl'

test('records are kept, blank lines, arrays and a partial last line are skipped', () => {
  const content = [
    JSON.stringify({ type: 'session', id: 's' }),
    '',
    JSON.stringify([1, 2]),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
    '{"type":"message","mess',
  ].join('\r\n')
  assert.deepEqual(parseSessionLines(content).map((entry) => entry.type), ['session', 'message'])
})

test('a missing file and an oversized file read as null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-jsonl-'))
  try {
    const file = join(dir, 's.jsonl')
    await writeFile(file, `${JSON.stringify({ type: 'session' })}\n`, 'utf8')
    assert.deepEqual((await readSessionEntries(file, 1024))?.map((entry) => entry.type), ['session'])
    assert.equal(await readSessionEntries(file, 4), null)
    assert.equal(await readSessionEntries(join(dir, 'missing.jsonl'), 1024), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function collect(filePath: string): Promise<Array<{ record: Record<string, unknown>; line: number }>> {
  const rows: Array<{ record: Record<string, unknown>; line: number }> = []
  for await (const row of streamJsonlRecords(filePath)) rows.push(row)
  return rows
}

test('streamJsonlRecords yields records with line numbers and skips bad lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-jsonl-'))
  try {
    const file = join(dir, 's.jsonl')
    await writeFile(file, '{"a":1}\nnot json\n{"b":2}\r\n[1]\n', 'utf8')
    assert.deepEqual(await collect(file), [
      { record: { a: 1 }, line: 0 },
      { record: { b: 2 }, line: 2 },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('streamJsonlRecords yields to the event loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-jsonl-'))
  try {
    const file = join(dir, 's.jsonl')
    await writeFile(file, `${JSON.stringify({ a: 1 })}\n`.repeat(JSONL_STREAM_YIELD_LINES * 3), 'utf8')
    // One read chunk holds the whole file, so only the reader's own yields
    // let a callback queued at the first record run before the last one.
    let recordsBeforeCallback = -1
    const rows: number[] = []
    for await (const { line } of streamJsonlRecords(file)) {
      if (rows.length === 0) setImmediate(() => { recordsBeforeCallback = rows.length })
      rows.push(line)
    }
    assert.equal(rows.length, JSONL_STREAM_YIELD_LINES * 3)
    assert.equal(recordsBeforeCallback, JSONL_STREAM_YIELD_LINES)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('streamJsonlRecords fails on a missing file', async () => {
  await assert.rejects(collect(join(tmpdir(), 'pi-chat-import-missing', 'none.jsonl')))
})
