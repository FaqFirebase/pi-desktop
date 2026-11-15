import type { PinnedSessionsMap, SessionListItem } from '../../../shared/ipc-contracts'

/**
 * Session rows with the pinned ones first, in pin order (the first pinned
 * stays on top), then the others newest first. Returns a new array.
 */
export function orderSessionsPinnedFirst<T extends Pick<SessionListItem, 'sessionId' | 'lastModified'>>(
  sessions: readonly T[],
  pinned: Readonly<PinnedSessionsMap>,
): T[] {
  const pinnedRows = sessions
    .filter((session) => session.sessionId in pinned)
    .sort((a, b) => pinned[a.sessionId] - pinned[b.sessionId] || a.sessionId.localeCompare(b.sessionId))
  const otherRows = sessions
    .filter((session) => !(session.sessionId in pinned))
    .sort((a, b) => b.lastModified - a.lastModified)
  return [...pinnedRows, ...otherRows]
}
