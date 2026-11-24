import type { PiCompactionEndEvent, PiCompactionStartEvent } from '../shared/ipc-contracts'

/**
 * OMP reports a manual compaction (the `compact` command, `/compact`) as a
 * `manual_compaction_start` / `manual_compaction_end` pair; Pi sends
 * `compaction_start` / `compaction_end` with reason "manual" for the same
 * thing. Rename OMP's pair to Pi's shape, so every consumer (chat notices,
 * timeline, compact buttons, Quick Chat) handles one event. Pi words a failed
 * manual compaction "Compaction failed: <reason>"; OMP sends the bare reason
 * ("Already compacted"), so it gets the same wording. Every other event
 * passes through unchanged.
 */
export function renameOmpEvent(event: unknown): unknown {
  if (typeof event !== 'object' || event === null) return event
  const fields = event as Record<string, unknown>
  if (fields.type === 'manual_compaction_start') {
    return { type: 'compaction_start', reason: 'manual' } satisfies PiCompactionStartEvent
  }
  if (fields.type !== 'manual_compaction_end') return event
  const aborted = fields.aborted === true
  const renamed: PiCompactionEndEvent = {
    type: 'compaction_end',
    reason: 'manual',
    result: fields.result,
    aborted,
    willRetry: false,
  }
  if (!aborted && typeof fields.errorMessage === 'string' && fields.errorMessage) {
    renamed.errorMessage = `Compaction failed: ${fields.errorMessage}`
  }
  return renamed
}
