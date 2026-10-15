/**
 * Rules every chat attachment follows, whether picked in the native dialog
 * (main reads it by path) or dropped onto the composer (the renderer reads the
 * granted File). One source, so the two paths cannot drift apart.
 */
import { t } from './i18n'

// Lowercase file extension -> MIME type for images we send as base64 image
// blocks. The dialog's image filter offers only SUPPORTED_IMAGE_EXTENSIONS;
// the extra formats here (avif/bmp/ico) arrive only through "All Files" or a drop.
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

const BYTES_PER_MEGABYTE = 1024 * 1024
const MAX_ATTACHMENT_MEGABYTES = 25
// Guard against accidentally base64-inlining a huge file into a prompt.
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MEGABYTES * BYTES_PER_MEGABYTE

/** Throws the localized "too large" error for a file over the attachment limit. */
export function assertAttachmentSize(sizeBytes: number): void {
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(t('errors.attachments.tooLarge', { limit: MAX_ATTACHMENT_MEGABYTES }))
  }
}

// Binary formats that can still decode as UTF-8 carry a NUL byte or, for PDF,
// this leading signature.
const NUL_CHARACTER = '\0'
const PDF_SIGNATURE = '%PDF-'

/**
 * Decodes a non-image attachment as UTF-8 text. Throws the localized "not a
 * text file" error for binary content (PDF, zip, Office files, and the like),
 * so it is never inlined into a prompt as garbage text.
 */
export function decodeTextAttachment(bytes: Uint8Array): string {
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(t('errors.attachments.notText'))
  }
  if (content.includes(NUL_CHARACTER) || content.startsWith(PDF_SIGNATURE)) {
    throw new Error(t('errors.attachments.notText'))
  }
  return content
}

/**
 * MIME type for a file name's extension if it is a supported image, else null.
 * A dotfile such as `.png` has no extension, as with Node's `extname`.
 */
export function imageMimeTypeForFileName(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return null
  const extension = fileName.slice(dot + 1).toLowerCase()
  // Own keys only, so a name like `file.constructor` never matches a prototype member.
  return Object.hasOwn(IMAGE_MIME_BY_EXTENSION, extension) ? IMAGE_MIME_BY_EXTENSION[extension] : null
}
