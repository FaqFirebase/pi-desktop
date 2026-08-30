import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import type { ForkPoint } from '../shared/fork-point'
import { isUserMessageRecord, userMessageText } from './session-metadata'

/**
 * Fork-point discovery for OMP sessions.
 *
 * Pi answers the `get_fork_messages` RPC with the user messages that can be
 * forked from; OMP removed that command (branching is `branch` + an entry id).
 * OMP keeps the same v3 session file layout — `{"type":"message","id":…}`
 * entries with 8-char hex ids — so the GUI reads the candidates straight from
 * the session file instead.
 */

/**
 * Fork candidate on a single session JSONL line: a user message entry that
 * carries an entry id. Returns null for every other record.
 */
export function forkPointFromLine(line: string): ForkPoint | null {
  // Cheap prefilter — most lines in a session are messages, but tool results
  // outnumber user turns and fail the role check before any allocation.
  if (!line || !line.includes('"message"')) return null
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (!isUserMessageRecord(record)) return null
  const id = (record as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) return null
  const text = userMessageText(record)
  if (text === null) return null
  return { entryId: id, text }
}

/**
 * Stream a session file and return its fork candidates in file (chronological)
 * order. Never throws — an unreadable or malformed file yields an empty list,
 * matching how the renderer treats a failed `get_fork_messages`.
 */
export async function readForkPoints(sessionPath: string): Promise<ForkPoint[]> {
  let stream
  try {
    stream = createReadStream(sessionPath, { encoding: 'utf-8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    const points: ForkPoint[] = []
    for await (const line of rl) {
      const point = forkPointFromLine(line)
      if (point) points.push(point)
    }
    return points
  } catch {
    return []
  } finally {
    stream?.destroy()
  }
}
