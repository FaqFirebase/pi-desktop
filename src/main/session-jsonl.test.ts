import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionLines, readSessionEntries } from './session-jsonl'

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
