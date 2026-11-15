// A Browser pane pick -> composer attachments: a text block (page, selector,
// element, text, HTML) and the element screenshot. The text block is a normal
// text attachment, so composePrompt wraps it as untrusted data at send time.
// Its labels are sent to the model, so they are English constants, not i18n.

import { MAX_ATTACHMENT_BYTES } from '../../../shared/attachment-rules'
import type { BrowserPick } from '../../../shared/browser-pick'
import type { ComposerAttachment } from '../store'

export const PICK_ATTACHMENT_PATH_PREFIX = 'browser-pick://'
export const PICK_ATTACHMENT_NAME_PREFIX = 'picked-'
export const PICK_TEXT_EXTENSION = '.md'
export const PICK_IMAGE_EXTENSION = '.png'
export const PNG_MIME_TYPE = 'image/png'

const PAGE_LABEL = 'Page: '
const SELECTOR_LABEL = 'Selector: '
const ELEMENT_LABEL = 'Element: '
const TEXT_HEADING = 'Text:'
const HTML_HEADING = 'HTML:'
const HTML_FENCE_LANGUAGE = 'html'
const BACKTICK = '`'
const MIN_FENCE_LENGTH = 3
const BACKTICK_RUN = /`+/g
const PNG_DATA_URL_PREFIX = `data:${PNG_MIME_TYPE};base64,`
const BASE64_PADDING = /=+$/
const BASE64_CHARS_PER_GROUP = 4
const BYTES_PER_BASE64_GROUP = 3

/** A backtick fence one longer than the longest backtick run in `content` (at least three). */
export function markdownFence(content: string): string {
  const longestRun = Math.max(0, ...(content.match(BACKTICK_RUN) ?? []).map((run) => run.length))
  return BACKTICK.repeat(Math.max(MIN_FENCE_LENGTH, longestRun + 1))
}

/** The text block of a pick; the fenced HTML snippet is last. */
export function formatPickedElement(pick: BrowserPick): string {
  const fence = markdownFence(pick.html)
  return [
    PAGE_LABEL + pick.url,
    SELECTOR_LABEL + pick.selector,
    ELEMENT_LABEL + pick.label,
    TEXT_HEADING,
    pick.text,
    HTML_HEADING,
    `${fence}${HTML_FENCE_LANGUAGE}\n${pick.html}\n${fence}`,
  ].join('\n')
}

/** The base64 bytes of a PNG data URL, or null for any other or an empty one. */
export function pngBase64FromDataUrl(dataUrl: string): string | null {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return null
  return dataUrl.slice(PNG_DATA_URL_PREFIX.length) || null
}

/** True when the decoded size of `base64` is within the chat attachment limit. */
export function fitsAttachmentLimit(base64: string): boolean {
  const padding = base64.match(BASE64_PADDING)?.[0].length ?? 0
  const bytes = Math.floor((base64.length * BYTES_PER_BASE64_GROUP) / BASE64_CHARS_PER_GROUP) - padding
  return bytes <= MAX_ATTACHMENT_BYTES
}

/**
 * The composer attachments of a pick: the text block, then the screenshot
 * when there is one. `nonce` keeps the paths unique, since the composer
 * drops an attachment whose path it already holds.
 */
export function buildPickAttachments(pick: BrowserPick, imageBase64: string | null, nonce: number): ComposerAttachment[] {
  const name = PICK_ATTACHMENT_NAME_PREFIX + pick.label
  const path = PICK_ATTACHMENT_PATH_PREFIX + nonce
  const attachments: ComposerAttachment[] = [
    { kind: 'text', name: name + PICK_TEXT_EXTENSION, path: path + PICK_TEXT_EXTENSION, content: formatPickedElement(pick) },
  ]
  if (imageBase64) {
    attachments.push({
      kind: 'image',
      name: name + PICK_IMAGE_EXTENSION,
      path: path + PICK_IMAGE_EXTENSION,
      image: { type: 'image', mimeType: PNG_MIME_TYPE, data: imageBase64 },
    })
  }
  return attachments
}
