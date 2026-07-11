import { readFile, stat } from 'fs/promises'
import { basename, extname } from 'path'
import type { AttachmentReadResult } from '../shared/ipc-contracts'

// Lowercase file extension -> MIME type for images we decode to base64 (for the
// preview pane's image viewer, and as Pi inline-image blocks). Note: the chat
// attachment picker is separately limited to SUPPORTED_IMAGE_EXTENSIONS, so the
// extra preview-only formats here (avif/bmp/ico) are never sent to Pi.
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

// Guard against accidentally base64-inlining a huge file into a prompt.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** MIME type for a path's extension if it is a supported image, else null. */
export function imageMimeTypeForPath(filePath: string): string | null {
  const ext = extname(filePath).slice(1).toLowerCase()
  return IMAGE_MIME_BY_EXTENSION[ext] ?? null
}

/**
 * Reads a user-selected attachment by absolute path (chosen via the native
 * open dialog, so it may live outside the workspace). Images become a
 * Pi-ready base64 payload; everything else is read as UTF-8 text to inline.
 */
export async function readAttachment(filePath: string): Promise<AttachmentReadResult> {
  const fileStat = await stat(filePath)
  if (fileStat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)`)
  }
  const name = basename(filePath)
  const mimeType = imageMimeTypeForPath(filePath)
  if (mimeType) {
    const bytes = await readFile(filePath)
    return {
      kind: 'image',
      name,
      image: { type: 'image', mimeType, data: bytes.toString('base64') },
    }
  }
  const content = await readFile(filePath, 'utf-8')
  return { kind: 'text', name, content }
}
