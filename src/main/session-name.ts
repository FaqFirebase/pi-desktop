import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { createInterface } from 'readline'

/**
 * Reads a session's display name out of its `.jsonl`.
 *
 * Pi stores the name as `{ "type": "session_info", "name": "…" }` records
 * appended over the session's life (via `/name`, the CLI `--name`, or an
 * auto-title extension). The **latest** record wins, and an empty name clears
 * the title. We only read — never write — so this degrades gracefully across Pi
 * format changes (worst case: no name found → caller falls back to the id).
 *
 * Large sessions can be multi‑MB. Streaming the whole file for every row in the
 * recent list freezes the Electron main process on boot (tens of seconds). We
 * only scan a small head (early auto-title) and a tail (later renames).
 */

/** Bytes to scan from the start (early session_info). */
const HEAD_BYTES = 32 * 1024
/** Bytes to scan from the end (latest renames append). */
const TAIL_BYTES = 256 * 1024

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

/** Scan a byte range of a session file for the latest session_info name. */
async function scanRangeForName(
  filePath: string,
  start: number,
  end: number,
  skipPartialFirstLine: boolean
): Promise<string | null | undefined> {
  if (end <= start) return undefined

  let name: string | null | undefined = undefined
  let first = true
  try {
    const stream = createReadStream(filePath, {
      encoding: 'utf8',
      start,
      end: Math.max(start, end - 1),
    })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      // When reading a mid-file tail, the first line may be a partial record.
      if (first && skipPartialFirstLine) {
        first = false
        continue
      }
      first = false
      const result = sessionInfoNameFromLine(line)
      if (result !== undefined) name = result
    }
  } catch {
    return undefined
  }
  return name
}

/**
 * Return the current display name, or null if unnamed.
 * Never throws. Bounded I/O — does not stream multi‑MB session bodies.
 */
export async function readSessionName(filePath: string): Promise<string | null> {
  try {
    const st = await stat(filePath)
    const size = st.size
    if (size <= 0) return null

    // Small files: one full pass (still via range so the codepath is unified).
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const full = await scanRangeForName(filePath, 0, size, false)
      return full === undefined ? null : full
    }

    const head = await scanRangeForName(filePath, 0, HEAD_BYTES, false)
    const tailStart = size - TAIL_BYTES
    const tail = await scanRangeForName(filePath, tailStart, size, true)

    // Prefer the tail (later renames append). Fall back to head auto-title.
    if (tail !== undefined) return tail
    if (head !== undefined) return head
    return null
  } catch {
    return null
  }
}

/** mtime-keyed cache so repeated list refreshes don't re-read the same files. */
const nameCache = new Map<string, { mtimeMs: number; name: string | null }>()

export async function readSessionNameCached(filePath: string, mtimeMs: number): Promise<string | null> {
  const hit = nameCache.get(filePath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.name
  const name = await readSessionName(filePath)
  nameCache.set(filePath, { mtimeMs, name })
  // Bound cache size (session list is capped at ~100; keep some headroom).
  if (nameCache.size > 500) {
    const first = nameCache.keys().next().value
    if (first !== undefined) nameCache.delete(first)
  }
  return name
}
