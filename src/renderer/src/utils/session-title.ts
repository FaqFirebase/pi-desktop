import type { SessionListItem } from '../../../shared/ipc-contracts'
import { pathsEqual } from '../../../shared/path-compare'

type SessionPreviewSource = Pick<SessionListItem, 'path' | 'preview'>

/**
 * Human-readable title for a session.
 *
 * Pi names session files `<timestamp>_<uuid>.jsonl`, so a filesystem-listed
 * session has no display name and a `sessionId` like
 * `2026-07-04T13-58-32-590Z_019f2d6c-...`. The previous fallback of
 * `sessionId.slice(0, 12)` was meant for short UUID prefixes; applied to a
 * timestamp id it yields `2026-07-04T1` for *every* session created the same
 * day (the slice stops mid-hour), making sessions indistinguishable.
 *
 * So: prefer an explicit name; then a preview of the session's first user
 * message, which is what actually distinguishes two same-day sessions; then, if
 * the id carries Pi's timestamp prefix, format it as `YYYY-MM-DD HH:MM:SS` (using
 * the wall-clock recorded in the filename); otherwise fall back to the short id
 * (e.g. a bare UUID).
 */

// Matches the leading "YYYY-MM-DDTHH-MM-SS" of a Pi session filename stem.
const SESSION_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/

export function getSessionTitle(
  name: string | null | undefined,
  sessionId: string,
  preview?: string | null
): string {
  if (name && name.trim()) return name.trim()
  if (preview && preview.trim()) return preview.trim()

  const m = SESSION_TIMESTAMP_RE.exec(sessionId)
  if (m) {
    const [, year, month, day, hour, minute, second] = m
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`
  }

  return sessionId.slice(0, 12)
}

/**
 * Preview of the live session's first user message, read from the session list.
 *
 * `SessionState` carries no preview, so a panel that titles the active session
 * from it alone falls back to the raw id while the same session's row in Recent
 * — which does read the list — shows a readable title. Matching on the session
 * file keeps the two labels in step.
 */
export function findSessionPreview(
  sessions: readonly SessionPreviewSource[],
  sessionFile: string | null | undefined
): string | null {
  if (!sessionFile) return null
  const match = sessions.find((session) => pathsEqual(session.path, sessionFile))
  return match?.preview ?? null
}
