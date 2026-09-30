import { t } from '../../../shared/i18n'
import { assertAttachmentSize, decodeTextAttachment, imageMimeTypeForFileName } from '../../../shared/attachment-rules'
import type { AttachmentReadResult } from '../../../shared/ipc-contracts'
import type { FileDragTransfer } from '../../../shared/folder-drop'
import { readFileAsBase64 } from './file-base64'

/**
 * Snapshot during drop: DataTransfer is no longer readable after an await.
 * Only confirmed files are claimed. A folder, or an item whose kind the drag
 * source leaves unknown, stays with the workspace folder-drop handler.
 */
export function droppedAttachmentFiles(transfer: FileDragTransfer): File[] {
  return Array.from(transfer.items ?? []).flatMap((item) => {
    if (item.kind !== 'file' || !item.webkitGetAsEntry?.()?.isFile) return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

/**
 * Read only the browser-granted File, never authorize an arbitrary disk path.
 * Same rules as the dialog path (main's readAttachment): images become base64
 * blocks, other files must be UTF-8 text.
 */
export async function readDroppedAttachment(file: File): Promise<AttachmentReadResult> {
  assertAttachmentSize(file.size)
  const mimeType = imageMimeTypeForFileName(file.name)
  if (mimeType) {
    return { kind: 'image', name: file.name, image: { type: 'image', mimeType, data: await readFileAsBase64(file) } }
  }
  return { kind: 'text', name: file.name, content: decodeTextAttachment(new Uint8Array(await file.arrayBuffer())) }
}

export interface DroppedAttachmentReads {
  attachments: Array<{ file: File; result: AttachmentReadResult }>
  errors: string[]
}

/**
 * Read dropped files in order. Returns null once `isDropCurrent` reports the
 * drop went stale during a read (the user switched workspace), so files dropped
 * in one workspace never land in another workspace's composer.
 */
export async function readDroppedAttachments(
  files: readonly File[],
  isDropCurrent: () => boolean
): Promise<DroppedAttachmentReads | null> {
  const reads: DroppedAttachmentReads = { attachments: [], errors: [] }
  for (const file of files) {
    try {
      reads.attachments.push({ file, result: await readDroppedAttachment(file) })
    } catch (error) {
      reads.errors.push(`${file.name}: ${error instanceof Error ? error.message : t('chat.attach.attachFailed')}`)
    }
    if (!isDropCurrent()) return null
  }
  return reads
}
