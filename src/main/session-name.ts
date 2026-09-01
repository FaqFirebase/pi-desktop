/**
 * Line-level parsing of a session's display name.
 *
 * Pi stores the name as `{ "type": "session_info", "name": "…" }` records
 * appended over the life of the session (via `/name`, the CLI `--name`, or an
 * auto-title extension). The **latest** record wins, and an empty name clears
 * the title. OMP instead rewrites a fixed-size `{ "type": "title", "title": "…" }`
 * slot on the file's first line and never writes `session_info` records, so a
 * title record is the fallback when no `session_info` exists. We only read —
 * never write — so this degrades gracefully across format changes (worst case:
 * no name found → caller falls back to the id).
 *
 * The bounded file reading that feeds these parsers lives in `session-metadata.ts`,
 * which extracts the name, the header and the first-message preview from one set
 * of range reads. Keeping the parsers here (pure, no `fs`) is what lets that
 * module import them without a cycle.
 */

/**
 * Extract a `session_info` name from a single JSONL line.
 * Returns the trimmed name, `null` if it's a session_info that clears the name
 * (empty), or `undefined` if the line isn't a session_info record at all.
 *
 * The tri-state matters: a range that contains no session_info at all must not
 * outrank an earlier range that found one.
 */
export function sessionInfoNameFromLine(line: string): string | null | undefined {
  const trimmed = line.trim()
  // Cheap prefilter so we don't JSON.parse every message line in large files.
  if (!trimmed || !trimmed.includes('"session_info"')) return undefined
  try {
    const record = JSON.parse(trimmed) as { type?: unknown; name?: unknown }
    if (record?.type !== 'session_info') return undefined
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    return name || null
  } catch {
    return undefined
  }
}

/**
 * Extract an OMP `title` name from a single JSONL line.
 * Returns the trimmed title, `null` for a title record whose slot is empty,
 * or `undefined` if the line isn't a title record at all — the same tri-state
 * as `sessionInfoNameFromLine`.
 */
export function titleNameFromLine(line: string): string | null | undefined {
  const trimmed = line.trim()
  // Cheap prefilter so we don't JSON.parse every message line in large files.
  if (!trimmed || !trimmed.includes('"title"')) return undefined
  try {
    const record = JSON.parse(trimmed) as { type?: unknown; title?: unknown }
    if (record?.type !== 'title') return undefined
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    return title || null
  } catch {
    return undefined
  }
}

/** Reduce a list of JSONL lines to the latest session_info name (or null). */
export function latestSessionName(lines: string[]): string | null {
  let name: string | null = null
  for (const line of lines) {
    const result = sessionInfoNameFromLine(line)
    if (result !== undefined) name = result
  }
  return name
}
