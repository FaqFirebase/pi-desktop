/**
 * Reads the end of a session file and decides whether the turn it ends on was
 * interrupted.
 *
 * Sessions reach many megabytes, so only the tail is read: the decision depends
 * on the last turn alone. Reuses nothing from `session-metadata` because that
 * reader is tuned for names and previews — it splits on `session_info` markers
 * and stops early — while this one needs a contiguous run of trailing messages,
 * wide enough that a tool result trailing its call by dozens of records is still
 * inside the window.
 */
import { open } from 'node:fs/promises'
import { stat } from 'node:fs/promises'

import { interruptionReason, tailMessagesFrom, type InterruptedReason } from '../shared/interrupted-turn'

/**
 * Bytes read from the end of the file.
 *
 * One turn's worth of a busy agent: tool calls, results, and the answer. 1 MB
 * covered the largest real turn seen on this machine (~11 MB session, thousands
 * of records) with room to spare, and reading it costs a single sequential read
 * that is dwarfed by the session-store walk the caller already does.
 */
export const TAIL_WINDOW_BYTES = 1024 * 1024

/** What the tail of a session file says about how it ended. */
export interface InterruptionCheck {
  /** Why the turn looks unfinished, or null when it does not. */
  reason: InterruptedReason | null
  /** True when the window did not reach the start of the file. */
  windowTruncated: boolean
}

/**
 * Classifies how a session file ends.
 *
 * Unreadable or empty files yield no reason: this decides whether to offer the
 * user a continuation, and a wrong "yes" is a message sent into a conversation
 * that did not need it.
 */
export async function detectInterruptedTurn(sessionPath: string): Promise<InterruptionCheck> {
  let handle
  try {
    const { size } = await stat(sessionPath)
    if (size === 0) return { reason: null, windowTruncated: false }
    const length = Math.min(TAIL_WINDOW_BYTES, size)
    const start = size - length
    handle = await open(sessionPath, 'r')
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const text = buffer.subarray(0, bytesRead).toString('utf-8')
    const lines = text.split('\n')
    // A window that starts mid-file starts mid-record, so its first line is a
    // fragment; dropping it keeps `JSON.parse` on whole records only.
    if (start > 0) lines.shift()

    const records: unknown[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        // A half-written final line happens when the process is killed mid-write.
        // Ignoring it is right: the records before it still describe the turn.
        continue
      }
    }

    return {
      reason: interruptionReason(tailMessagesFrom(records)),
      windowTruncated: start > 0,
    }
  } catch {
    return { reason: null, windowTruncated: false }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
