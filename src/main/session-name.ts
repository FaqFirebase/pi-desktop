import { createReadStream } from 'fs'
import { createInterface } from 'readline'

/**
 * Reads a session's display name out of its `.jsonl`.
 *
 * Pi stores the name as `{ "type": "session_info", "name": "…" }` records
 * appended over the session's life (via `/name`, the CLI `--name`, or an
 * auto-title extension). The **latest** record wins, and an empty name clears
 * the title. We only read — never write — so this degrades gracefully across Pi
 * format changes (worst case: no name found → caller falls back to the id).
 */

/**
 * Extract a `session_info` name from a single JSONL line.
 * Returns the trimmed name, `null` if it's a session_info that clears the name
 * (empty), or `undefined` if the line isn't a session_info record at all.
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

/** Reduce a list of JSONL lines to the latest session_info name (or null). */
export function latestSessionName(lines: string[]): string | null {
  let name: string | null = null
  for (const line of lines) {
    const result = sessionInfoNameFromLine(line)
    if (result !== undefined) name = result
  }
  return name
}

/**
 * Stream a session file and return its current name, or null if unnamed.
 * Streams line-by-line (bounded memory) and never throws.
 */
export async function readSessionName(filePath: string): Promise<string | null> {
  let name: string | null = null
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      const result = sessionInfoNameFromLine(line)
      if (result !== undefined) name = result
    }
  } catch {
    return null
  }
  return name
}
