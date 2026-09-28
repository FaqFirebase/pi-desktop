import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_ATTACHMENT_BYTES, assertAttachmentSize, decodeTextAttachment, imageMimeTypeForFileName } from './attachment-rules'

test('imageMimeTypeForFileName maps supported image extensions case-insensitively', () => {
  assert.equal(imageMimeTypeForFileName('shot.png'), 'image/png')
  assert.equal(imageMimeTypeForFileName('shot.JPG'), 'image/jpeg')
  assert.equal(imageMimeTypeForFileName('photo.jpeg'), 'image/jpeg')
  assert.equal(imageMimeTypeForFileName('anim.GIF'), 'image/gif')
  assert.equal(imageMimeTypeForFileName('pic.webp'), 'image/webp')
})

test('imageMimeTypeForFileName returns null for non-image and extensionless names', () => {
  assert.equal(imageMimeTypeForFileName('notes.txt'), null)
  assert.equal(imageMimeTypeForFileName('archive.tar.gz'), null)
  assert.equal(imageMimeTypeForFileName('Makefile'), null)
  assert.equal(imageMimeTypeForFileName('png'), null)
  assert.equal(imageMimeTypeForFileName('.png'), null)
  assert.equal(imageMimeTypeForFileName('image.svg'), null) // not in Pi's supported set
})

test('imageMimeTypeForFileName ignores inherited object members', () => {
  assert.equal(imageMimeTypeForFileName('file.constructor'), null)
  assert.equal(imageMimeTypeForFileName('file.toString'), null)
})

test('assertAttachmentSize accepts the limit and rejects one byte more', () => {
  assert.doesNotThrow(() => assertAttachmentSize(MAX_ATTACHMENT_BYTES))
  assert.throws(() => assertAttachmentSize(MAX_ATTACHMENT_BYTES + 1), /too large/i)
})

test('decodeTextAttachment returns UTF-8 text, including empty files', () => {
  const encoder = new TextEncoder()
  assert.equal(decodeTextAttachment(encoder.encode('¡Hola! 日本語')), '¡Hola! 日本語')
  assert.equal(decodeTextAttachment(encoder.encode('<svg/>')), '<svg/>')
  assert.equal(decodeTextAttachment(new Uint8Array()), '')
})

test('decodeTextAttachment rejects invalid UTF-8, NUL bytes, and PDF content', () => {
  const INVALID_UTF8_BYTES = new Uint8Array([255, 254])
  const ZIP_LOCAL_HEADER_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
  const encoder = new TextEncoder()
  for (const bytes of [INVALID_UTF8_BYTES, ZIP_LOCAL_HEADER_BYTES, encoder.encode('%PDF-1.7\n')]) {
    assert.throws(() => decodeTextAttachment(bytes), /not a text file/i)
  }
})
