import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { readAttachment } from './attachment-reader'

// ─── readAttachment ─────────────────────────────────────────────────────────

test('readAttachment returns base64 image payload for an image file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-attach-img-'))
  const file = join(dir, 'pixel.png')
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await writeFile(file, bytes)

  const result = await readAttachment(file)
  assert.equal(result.kind, 'image')
  if (result.kind !== 'image') return
  assert.equal(result.name, 'pixel.png')
  assert.equal(result.image.type, 'image')
  assert.equal(result.image.mimeType, 'image/png')
  assert.equal(result.image.data, bytes.toString('base64'))
})

test('readAttachment returns UTF-8 text for a non-image file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-attach-txt-'))
  const file = join(dir, 'notes.md')
  await writeFile(file, '# Hello\nworld')

  const result = await readAttachment(file)
  assert.equal(result.kind, 'text')
  if (result.kind !== 'text') return
  assert.equal(result.name, 'notes.md')
  assert.equal(result.content, '# Hello\nworld')
})

test('readAttachment rejects a binary non-image file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-attach-bin-'))
  const file = join(dir, 'document.pdf')
  await writeFile(file, '%PDF-1.7\n')

  await assert.rejects(() => readAttachment(file), /not a text file/i)
})

test('readAttachment rejects a missing path', async () => {
  await assert.rejects(() => readAttachment('/no/such/file-xyz.png'))
})
