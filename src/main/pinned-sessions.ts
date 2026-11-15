import type { SessionTimestampMap } from './session-timestamp-store'

/**
 * Pinned sessions: a GUI-side registry, { "<sessionId>": <pinnedAtEpochMs> },
 * kept in this file of the GUI data dir by a SessionTimestampStore.
 */
export const PINNED_SESSIONS_FILE_NAME = 'pinned-sessions.json'

/**
 * The rows the session list returns: the first `limit` rows, plus every later
 * row that is pinned, in input order. A pinned session older than the list cap
 * stays listed, so it can stay on top of its group.
 */
export function selectListedSessions<T extends { sessionId: string }>(
  sorted: readonly T[],
  limit: number,
  pinned: Readonly<SessionTimestampMap>,
): T[] {
  return sorted.filter((row, index) => index < limit || row.sessionId in pinned)
}
