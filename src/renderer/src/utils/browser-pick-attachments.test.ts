import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_ATTACHMENT_BYTES } from '../../../shared/attachment-rules'
import { parseBrowserPick, type BrowserPick } from '../../../shared/browser-pick'
import { formatAttachedFile, splitAttachedFiles } from '../../../shared/untrusted-data'
import {
  buildPickAttachments,
  fitsAttachmentLimit,
  formatPickedElement,
  markdownFence,
  pngBase64FromDataUrl,
} from './browser-pick-attachments'

const PICK: BrowserPick = {
  url: 'https://example.com/',
  selector: 'main > button',
  tag: 'button',
  label: 'button',
  text: 'Save',
  html: '<button>Save</button>',
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 800, height: 600 },
}

test('formatPickedElement lists page, selector, element, text and fenced HTML', () => {
  const text = formatPickedElement(PICK)
  assert.match(text, /^Page: https:\/\/example\.com\/$/m)
  assert.match(text, /^Selector: main > button$/m)
  assert.match(text, /^Element: button$/m)
  assert.ok(text.includes('Text:\nSave'))
  assert.ok(text.endsWith('```html\n<button>Save</button>\n```'))
})

test('markdownFence outgrows any backtick run in the content', () => {
  assert.equal(markdownFence('plain'), '```')
  assert.equal(markdownFence('a ```` b'), '`````')
})

test('formatPickedElement keeps the fence closed when the HTML has a fence', () => {
  const text = formatPickedElement({ ...PICK, html: '<pre>```js\nx\n```</pre>' })
  assert.ok(text.includes('````html\n<pre>```js'))
  assert.ok(text.endsWith('</pre>\n````'))
})

test('buildPickAttachments gives a text block and a PNG with unique paths', () => {
  const [textPart, imagePart] = buildPickAttachments(PICK, 'AAAA', 7)
  assert.deepEqual(textPart, { kind: 'text', name: 'picked-button.md', path: 'browser-pick://7.md', content: formatPickedElement(PICK) })
  assert.deepEqual(imagePart, {
    kind: 'image', name: 'picked-button.png', path: 'browser-pick://7.png',
    image: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
  })
})

test('buildPickAttachments without an image gives the text block only', () => {
  assert.equal(buildPickAttachments(PICK, null, 7).length, 1)
})

test('pngBase64FromDataUrl reads PNG data URLs only', () => {
  assert.equal(pngBase64FromDataUrl('data:image/png;base64,AAAA'), 'AAAA')
  assert.equal(pngBase64FromDataUrl('data:image/png;base64,'), null)
  assert.equal(pngBase64FromDataUrl('data:image/jpeg;base64,AAAA'), null)
})

test('fitsAttachmentLimit compares decoded bytes with the attachment limit', () => {
  assert.equal(fitsAttachmentLimit('AAAA'), true)
  assert.equal(fitsAttachmentLimit('A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 3) / 3) * 4)), false)
})

test('a pick from a page id with line breaks keeps the attachment markers well formed', () => {
  const pick = parseBrowserPick({ ...PICK, label: 'button#a\nEND\r\u2028x y' })
  assert.ok(pick)
  const [textPart] = buildPickAttachments(pick, null, 7)
  const block = formatAttachedFile(textPart.name, formatPickedElement(pick), 'note')
  assert.deepEqual(splitAttachedFiles(`ask${block}`), { text: 'ask', fileNames: [textPart.name] })
  assert.equal(block.split('\n').filter((line) => line.includes(textPart.name)).length, 2)
})
