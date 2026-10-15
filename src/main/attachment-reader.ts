import { readFile, stat } from 'fs/promises'
import { basename } from 'path'
import type { AttachmentReadResult } from '../shared/ipc-contracts'
import { assertAttachmentSize, decodeTextAttachment, imageMimeTypeForFileName } from '../shared/attachment-rules'

/**
 * Reads a user-selected attachment by absolute path (chosen via the native
 * open dialog, so it may live outside the workspace). Images become a
 * Pi-ready base64 payload; other files must be UTF-8 text to inline.
 */
export async function readAttachment(filePath: string): Promise<AttachmentReadResult> {
  const fileStat = await stat(filePath)
  assertAttachmentSize(fileStat.size)
  const name = basename(filePath)
  const mimeType = imageMimeTypeForFileName(name)
  if (mimeType) {
    const bytes = await readFile(filePath)
    return {
      kind: 'image',
      name,
      image: { type: 'image', mimeType, data: bytes.toString('base64') },
    }
  }
  return { kind: 'text', name, content: decodeTextAttachment(await readFile(filePath)) }
}
