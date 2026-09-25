import assert from 'node:assert/strict'
import { test } from 'node:test'
import { droppedAttachmentFiles, readDroppedAttachment } from './dropped-attachments'

const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })

test('drop snapshots multiple files in order, excluding directories and string items', () => {
  const image = new File(['image'], 'photo.png')
  assert.deepEqual(droppedAttachmentFiles({
    types: ['Files'],
    items: [
      { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
      { kind: 'file', getAsFile: () => new File([], 'folder'), webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }) },
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => image, webkitGetAsEntry: () => null },
    ],
  }), [file, image])
})

test('files-only drag sources are supported', () => {
  assert.deepEqual(droppedAttachmentFiles({ types: ['Files'], files: [file] }), [file])
  assert.deepEqual(droppedAttachmentFiles({ types: ['Files'] }), [])
})

test('UTF-8 documents and code are read directly from the granted File', async () => {
  assert.deepEqual(await readDroppedAttachment(file), { kind: 'text', name: 'notes.txt', content: 'hello' })
  assert.deepEqual(await readDroppedAttachment(new File(['¡Hola! 日本語'], 'code.ts')), {
    kind: 'text', name: 'code.ts', content: '¡Hola! 日本語',
  })
  assert.equal((await readDroppedAttachment(new File([], 'empty.txt'))).kind, 'text')
  assert.equal((await readDroppedAttachment(new File(['<svg/>'], 'drawing.svg', { type: 'image/svg+xml' }))).kind, 'text')
})

test('supported images become base64 blocks, even when the OS omits MIME type', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255])
  assert.deepEqual(await readDroppedAttachment(new File([bytes], 'PHOTO.PNG')), {
    kind: 'image', name: 'PHOTO.PNG',
    image: { type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') },
  })
  assert.equal((await readDroppedAttachment(new File([bytes], 'photo', { type: 'image/jpeg' }))).kind, 'image')
})

test('binary documents and unsupported images fail instead of inlining corrupt text', async () => {
  for (const unsupported of [
    new File(['%PDF-1.7\n'], 'document.pdf'),
    new File(['PK\x03\x04\0'], 'document.docx'),
    new File([new Uint8Array([255, 254])], 'binary.dat'),
    new File(['BM\0'], 'image.bmp', { type: 'image/bmp' }),
  ]) {
    await assert.rejects(readDroppedAttachment(unsupported), /Unsupported file format/)
  }
})

test('oversized attachments are rejected before reading', async () => {
  await assert.rejects(readDroppedAttachment({
    size: 25 * 1024 * 1024 + 1,
    arrayBuffer: () => { throw new Error('must not read') },
  } as unknown as File), /too large/i)
})

test('unusual filenames cannot match inherited image MIME map properties', async () => {
  assert.equal((await readDroppedAttachment(new File(['text'], 'file.constructor'))).kind, 'text')
})
