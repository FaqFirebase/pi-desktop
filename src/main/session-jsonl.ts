import { readFile, stat } from 'fs/promises'
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
