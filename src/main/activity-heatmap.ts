import { readdir, stat, readFile as fsReadFile } from 'fs/promises'
import { join } from 'path'
import { getSessionsRoot } from './pi-paths'
import type { ActivityDay, ActivityHeatmapResult } from '../shared/ipc-contracts'

export const WINDOW_DAYS = 365
export const MESSAGE_RECORD_TYPE = 'message'
const JSONL_EXTENSION = '.jsonl'
const MS_PER_DAY = 86_400_000

interface ActivityReaderDeps {
  sessionsRoot?: string
  readFileImpl?: (path: string) => Promise<string>
}

interface CacheEntry {
  mtimeMs: number
  daily: Map<string, number> // local YYYY-MM-DD -> count
}

/** Local-time YYYY-MM-DD for a Date. */
function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse one session file into a local-day -> message-count map. */
function binFile(content: string): Map<string, number> {
  const daily = new Map<string, number>()
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const rec = record as { type?: unknown; timestamp?: unknown }
    if (rec.type !== MESSAGE_RECORD_TYPE || typeof rec.timestamp !== 'string') continue
    const when = new Date(rec.timestamp)
    if (Number.isNaN(when.getTime())) continue
    const key = localDayKey(when)
    daily.set(key, (daily.get(key) ?? 0) + 1)
  }
  return daily
}

async function collectJsonlFiles(dir: string, out: string[]): Promise<void> {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const full = join(dir, item.name)
    if (item.isDirectory()) {
      await collectJsonlFiles(full, out)
    } else if (item.isFile() && item.name.endsWith(JSONL_EXTENSION)) {
      out.push(full)
    }
  }
}

/**
 * Build a reader that aggregates per-day message activity across all session
 * files. Holds a per-file mtime cache so repeat calls only re-parse changed
 * files. `deps` are injectable for tests; production uses the real root.
 */
export function createActivityHeatmapReader(deps: ActivityReaderDeps = {}): {
  compute(now?: Date): Promise<ActivityHeatmapResult>
} {
  const readFileImpl = deps.readFileImpl ?? ((p: string) => fsReadFile(p, 'utf-8'))
  const cache = new Map<string, CacheEntry>()

  async function compute(now: Date = new Date()): Promise<ActivityHeatmapResult> {
    const root = deps.sessionsRoot ?? getSessionsRoot()
    const files: string[] = []
    await collectJsonlFiles(root, files)
    const present = new Set(files)

    // Evict cache entries for files that no longer exist.
    for (const cached of [...cache.keys()]) {
      if (!present.has(cached)) cache.delete(cached)
    }

    for (const file of files) {
      let mtimeMs: number
      try {
        mtimeMs = (await stat(file)).mtimeMs
      } catch {
        cache.delete(file)
        continue
      }
      const hit = cache.get(file)
      if (hit && hit.mtimeMs === mtimeMs) continue
      try {
        const content = await readFileImpl(file)
        cache.set(file, { mtimeMs, daily: binFile(content) })
      } catch {
        cache.delete(file)
      }
    }

    // Sum all per-file maps into one global map.
    const global = new Map<string, number>()
    for (const entry of cache.values()) {
      for (const [key, count] of entry.daily) {
        global.set(key, (global.get(key) ?? 0) + count)
      }
    }

    // Emit the trailing WINDOW_DAYS window, zero-filled and ascending.
    const days: ActivityDay[] = []
    let total = 0
    let maxCount = 0
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(todayMidnight.getTime() - i * MS_PER_DAY)
      const key = localDayKey(d)
      const count = global.get(key) ?? 0
      days.push({ date: key, count })
      total += count
      if (count > maxCount) maxCount = count
    }

    return { days, total, maxCount }
  }

  return { compute }
}

/** Production singleton; retains its cache across IPC calls. */
export const activityHeatmapReader = createActivityHeatmapReader()
