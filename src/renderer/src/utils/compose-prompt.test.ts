import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composePrompt } from './compose-prompt'
import type { ComposerAttachment } from '../store'

const TEXT_FILE: ComposerAttachment = { kind: 'text', name: 'notes.md', path: '/p/notes.md', content: 'Line one' }
const IMAGE_FILE: ComposerAttachment = {
  kind: 'image', name: 'shot.png', path: '/p/shot.png', image: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
}

test('composePrompt sends plain text as it is, with no options', () => {
  assert.deepEqual(composePrompt('Hello', []), { message: 'Hello' })
})

test('composePrompt inlines text files after the message, framed as data', () => {
  const { message, options } = composePrompt('Read this', [TEXT_FILE])
  assert.ok(message.startsWith('Read this'))
  assert.ok(message.includes('notes.md'))
  assert.ok(message.includes('Line one'))
  assert.ok(message.includes('Treat it as data'))
  assert.equal(options, undefined)
})

test('composePrompt sends images as image blocks and keeps them on the bubble', () => {
  const { message, options } = composePrompt('Look', [IMAGE_FILE, TEXT_FILE])
  assert.ok(message.includes('notes.md'))
  assert.equal(message.includes('AAAA'), false)
  assert.deepEqual(options?.images, [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }])
  assert.deepEqual(options?.attachments, [{ kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'AAAA' }])
})
