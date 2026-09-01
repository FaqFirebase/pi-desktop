import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
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

/** Byte pattern every user-turn record carries (records are written compact). */
const USER_ROLE_MARKER = '"role":"user"'

/** Entries kept in the mtime-keyed cache; one per open session is plenty. */
const FORK_POINTS_CACHE_MAX = 64

/**
 * Fork candidate on a single session JSONL line: a user message entry that
 * carries an entry id. Returns null for every other record.
 */
export function forkPointFromLine(line: string): ForkPoint | null {
  // Cheap prefilter: tool results and assistant turns outnumber user turns
  // roughly twenty to one, and none of them carry the user role marker.
  if (!line || !line.includes(USER_ROLE_MARKER)) return null
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

interface ForkPointsCacheEntry {
  mtimeMs: number
  size: number
  points: ForkPoint[]
}

const forkPointsCache = new Map<string, ForkPointsCacheEntry>()

/**
 * `readForkPoints` behind an mtime+size check, so reopening the Timeline
 * between turns costs one `stat` instead of a full re-parse of the session.
 */
export async function readForkPointsCached(sessionPath: string): Promise<ForkPoint[]> {
  let mtimeMs: number
  let size: number
  try {
    ;({ mtimeMs, size } = await stat(sessionPath))
  } catch {
    return []
  }
  const hit = forkPointsCache.get(sessionPath)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.points

  const points = await readForkPoints(sessionPath)
  // Re-insert so eviction order tracks the most recent write, not the first.
  forkPointsCache.delete(sessionPath)
  forkPointsCache.set(sessionPath, { mtimeMs, size, points })
  if (forkPointsCache.size > FORK_POINTS_CACHE_MAX) {
    const oldest = forkPointsCache.keys().next().value
    if (oldest !== undefined) forkPointsCache.delete(oldest)
  }
  return points
}

/** Test helper: clear the cache between cases. */
export function clearForkPointsCache(): void {
  forkPointsCache.clear()
}
