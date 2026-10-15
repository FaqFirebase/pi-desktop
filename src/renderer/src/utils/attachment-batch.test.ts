import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttachmentReadResult } from '../../../shared/ipc-contracts'
import { readAttachmentBatch, type AttachmentSource } from './attachment-batch'

function textSource(name: string, read?: () => Promise<AttachmentReadResult>): AttachmentSource {
  return {
    label: name,
    path: `/picked/${name}`,
    read: read ?? (async () => ({ kind: 'text', name, content: name })),
  }
}

test('a batch keeps its order, keys each attachment by its path, and reports each failed file by label', async () => {
  const failing = textSource('huge.txt', async () => {
    throw new Error('File is too large')
  })
  const batch = await readAttachmentBatch([textSource('a.txt'), failing, textSource('b.txt')], () => true)

  assert.deepEqual(batch?.attachments, [
    { kind: 'text', name: 'a.txt', content: 'a.txt', path: '/picked/a.txt' },
    { kind: 'text', name: 'b.txt', content: 'b.txt', path: '/picked/b.txt' },
  ])
  assert.deepEqual(batch?.errors, ['huge.txt: File is too large'])
})

test('main-process errors lose the Electron IPC prefix', async () => {
  const rejected = textSource('/outside/secret.txt', async () => {
    throw new Error("Error invoking remote method 'file:read-attachment': Error: Path not permitted")
  })
  const batch = await readAttachmentBatch([rejected], () => true)

  assert.deepEqual(batch?.errors, ['/outside/secret.txt: Path not permitted'])
})

test('a batch that goes stale mid-read is discarded, not attached elsewhere', async () => {
  const BATCH_WORKSPACE_ID = 'ws-a'
  let activeWorkspaceId = BATCH_WORKSPACE_ID
  let secondFileRead = false
  // The user switches workspace while the first file is read.
  const switching = textSource('first.txt', async () => {
    activeWorkspaceId = 'ws-b'
    return { kind: 'text', name: 'first.txt', content: 'first' }
  })
  const second = textSource('second.txt', async () => {
    secondFileRead = true
    return { kind: 'text', name: 'second.txt', content: 'second' }
  })

  const batch = await readAttachmentBatch([switching, second], () => activeWorkspaceId === BATCH_WORKSPACE_ID)

  assert.equal(batch, null)
  assert.equal(secondFileRead, false, 'no further files are read once the batch is stale')
})
