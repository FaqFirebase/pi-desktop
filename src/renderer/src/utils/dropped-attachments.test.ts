import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { MAX_ATTACHMENT_BYTES } from '../../../shared/attachment-rules'
import { droppedAttachmentFiles, readDroppedAttachment } from './dropped-attachments'

// Node has no FileReader; this stand-in yields the data URL the renderer's reads.
class DataUrlFileReader {
  result: string | null = null
  error: Error | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  readAsDataURL(blob: File): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
      this.onload?.()
    })
  }
}

before(() => {
  ;(globalThis as unknown as { FileReader: unknown }).FileReader = DataUrlFileReader
})

const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
const FILE_ENTRY = { isDirectory: false, isFile: true }
const FOLDER_ENTRY = { isDirectory: true, isFile: false }

test('drop snapshots multiple files in order, excluding folders and string items', () => {
  const image = new File(['image'], 'photo.png')
  assert.deepEqual(droppedAttachmentFiles({
    types: ['Files'],
    items: [
      { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => FILE_ENTRY },
      { kind: 'file', getAsFile: () => new File([], 'folder'), webkitGetAsEntry: () => FOLDER_ENTRY },
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => image, webkitGetAsEntry: () => FILE_ENTRY },
    ],
  }), [file, image])
})

test('items of unknown kind stay with the folder-drop handler', () => {
  assert.deepEqual(droppedAttachmentFiles({
    types: ['Files'],
    items: [
      { kind: 'file', getAsFile: () => new File([], 'maybe-folder'), webkitGetAsEntry: () => null },
      { kind: 'file', getAsFile: () => new File([], 'no-entry-api') },
    ],
  }), [])
  assert.deepEqual(droppedAttachmentFiles({ types: ['Files'] }), [])
})

test('documents and code are read directly from the granted File', async () => {
  assert.deepEqual(await readDroppedAttachment(file), { kind: 'text', name: 'notes.txt', content: 'hello' })
  assert.deepEqual(await readDroppedAttachment(new File(['¡Hola! 日本語'], 'code.ts')), {
    kind: 'text', name: 'code.ts', content: '¡Hola! 日本語',
  })
  assert.equal((await readDroppedAttachment(new File([], 'empty.txt'))).kind, 'text')
  assert.equal((await readDroppedAttachment(new File(['<svg/>'], 'drawing.svg', { type: 'image/svg+xml' }))).kind, 'text')
})

test('binary files are rejected instead of inlined as garbage text, as in the dialog path', async () => {
  const INVALID_UTF8_BYTES = new Uint8Array([255, 254])
  for (const binary of [
    new File([INVALID_UTF8_BYTES], 'binary.dat'),
    new File(['%PDF-1.7\n'], 'document.pdf'),
    new File(['PK\x03\x04\0'], 'document.docx'),
  ]) {
    await assert.rejects(readDroppedAttachment(binary), /not a text file/i)
  }
})

test('image extensions become base64 blocks by name, as in the dialog path', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255])
  assert.deepEqual(await readDroppedAttachment(new File([bytes], 'PHOTO.PNG')), {
    kind: 'image', name: 'PHOTO.PNG',
    image: { type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') },
  })
})

test('oversized attachments are rejected before reading', async () => {
  await assert.rejects(readDroppedAttachment({
    name: 'huge.txt',
    size: MAX_ATTACHMENT_BYTES + 1,
    arrayBuffer: () => { throw new Error('must not read') },
  } as unknown as File), /too large/i)
})
