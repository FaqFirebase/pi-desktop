import { t } from '../../../shared/i18n'
import type { AttachmentReadResult } from '../../../shared/ipc-contracts'
import type { ComposerAttachment } from '../store'
import { formatIpcError } from './ipc-error'

/** One file to stage: `label` names it in errors, `path` keys the staged attachment. */
export interface AttachmentSource {
  label: string
  path: string
  read: () => Promise<AttachmentReadResult>
}

export interface AttachmentBatch {
  attachments: ComposerAttachment[]
  errors: string[]
}

/**
 * Read picked or dropped files in order. A failed file is reported by its
 * label and does not stop the others. Returns null once `isBatchCurrent`
 * reports the batch went stale during a read (the user switched workspace),
 * so files chosen in one workspace never land in another workspace's composer.
 */
export async function readAttachmentBatch(
  sources: readonly AttachmentSource[],
  isBatchCurrent: () => boolean
): Promise<AttachmentBatch | null> {
  const batch: AttachmentBatch = { attachments: [], errors: [] }
  for (const source of sources) {
    try {
      batch.attachments.push({ ...(await source.read()), path: source.path })
    } catch (error) {
      batch.errors.push(`${source.label}: ${error instanceof Error ? formatIpcError(error) : t('chat.attach.attachFailed')}`)
    }
    if (!isBatchCurrent()) return null
  }
  return batch
}
