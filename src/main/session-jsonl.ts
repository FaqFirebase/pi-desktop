import { createReadStream } from 'fs'
import { readFile, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { setImmediate as yieldToEventLoop } from 'timers/promises'
import { isObject } from './ipc/validation'

const LINE_BREAK = /\r?\n/

/**
 * Parse a session JSONL file's text into its object entries. A live session
 * can end with a partial line; it is skipped so the readable prefix is kept.
 */
export function parseSessionLines(content: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (const line of content.split(LINE_BREAK)) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isObject(value)) entries.push(value)
    } catch {
      // Partial or corrupt line: keep the rest of the file.
    }
  }
  return entries
}

/** A session file's entries, or null when it is missing, unreadable or larger than `maxBytes`. */
export async function readSessionEntries(filePath: string, maxBytes: number): Promise<Record<string, unknown>[] | null> {
  try {
    const file = await stat(filePath)
    if (file.size > maxBytes) return null
    return parseSessionLines(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

/** Lines read between two yields to the event loop. */
export const JSONL_STREAM_YIELD_LINES = 200

/**
 * Parsed object records with 0-based line numbers. Opens read-only; yields to
 * the event loop every JSONL_STREAM_YIELD_LINES lines so a huge file never
 * blocks the main process; skips bad lines. Rejects when the file cannot be read.
 */
export async function* streamJsonlRecords(filePath: string): AsyncGenerator<{ record: Record<string, unknown>; line: number }> {
  const stream = createReadStream(filePath, { flags: 'r', encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let line = -1
  try {
    for await (const text of lines) {
      line++
      if (line > 0 && line % JSONL_STREAM_YIELD_LINES === 0) await yieldToEventLoop()
      if (!text.trim()) continue
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        continue
      }
      if (isObject(value)) yield { record: value, line }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}
