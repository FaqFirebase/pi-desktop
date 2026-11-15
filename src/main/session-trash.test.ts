import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSessionFile, moveToTrash, type TrashItem } from './session-trash'

/**
 * A deleted session must land in the operating system trash on every OS. The
 * regression these cover: only the Linux `trash` and `gio` helpers were tried,
 * so on Windows and macOS every delete became a permanent unlink.
 */

const SESSION_FILE_NAME = 'a.jsonl'
const SESSION_LINE = '{"type":"session"}\n'

function recordingTrash(outcome: 'resolve' | 'reject'): { trashItem: TrashItem; calls: string[] } {
  const calls: string[] = []
  const trashItem: TrashItem = async (targetPath) => {
    calls.push(targetPath)
    if (outcome === 'reject') throw new Error('trash refused')
  }
  return { trashItem, calls }
}

async function withSessionFile(run: (sessionPath: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'session-trash-'))
  const sessionPath = join(dir, SESSION_FILE_NAME)
  await writeFile(sessionPath, SESSION_LINE, 'utf-8')
  try {
    await run(sessionPath, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the trash call receives the session path and its success is reported', async () => {
  const { trashItem, calls } = recordingTrash('resolve')
  assert.equal(await moveToTrash('/home/u/.pi/agent/sessions/p/a.jsonl', trashItem), true)
  assert.deepEqual(calls, ['/home/u/.pi/agent/sessions/p/a.jsonl'])
})

test('a refused trash call is reported as a failure, not thrown', async () => {
  const { trashItem } = recordingTrash('reject')
  assert.equal(await moveToTrash('/home/u/.pi/agent/sessions/p/a.jsonl', trashItem), false)
})

test('a delete goes to the trash and never unlinks when the trash accepts it', async () => {
  await withSessionFile(async (sessionPath, dir) => {
    const trashed = join(dir, 'trashed.jsonl')
    const result = await deleteSessionFile(sessionPath, (targetPath) => rename(targetPath, trashed))
    assert.deepEqual(result, { ok: true, method: 'trash' })
    assert.equal(existsSync(trashed), true, 'the session must be recoverable from the trash')
  })
})

test('a trash call that moved the file but rejected still counts as trashed', async () => {
  await withSessionFile(async (sessionPath, dir) => {
    const result = await deleteSessionFile(sessionPath, async (targetPath) => {
      await rename(targetPath, join(dir, 'trashed.jsonl'))
      throw new Error('moved, then failed to report')
    })
    assert.deepEqual(result, { ok: true, method: 'trash' })
  })
})

test('a refused trash falls back to unlink so the delete still happens', async () => {
  await withSessionFile(async (sessionPath) => {
    const result = await deleteSessionFile(sessionPath, recordingTrash('reject').trashItem)
    assert.deepEqual(result, { ok: true, method: 'unlink' })
    assert.equal(existsSync(sessionPath), false)
  })
})
