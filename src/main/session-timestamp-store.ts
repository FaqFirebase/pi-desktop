import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { getGuiDataPath } from './app-data-paths'

/**
 * A GUI-side registry of sessions, each with the time it entered the registry.
 *
 * Shape on disk: { "<sessionId>": <epochMs> } in the GUI data dir.
 * The session ID is the file basename without `.jsonl` (`sessionIdFromPath`),
 * the same key session tags use, for Pi and OMP sessions alike.
 *
 * A hand-edited or damaged file never breaks the app: entries whose value is
 * not a finite number are dropped on load, and the next write repairs the file.
 */

export type SessionTimestampMap = Record<string, number>

function parseTimestampMap(parsed: unknown): SessionTimestampMap {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const map: SessionTimestampMap = {}
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (typeof value === 'number' && Number.isFinite(value)) map[sessionId] = value
  }
  return map
}

export class SessionTimestampStore {
  private readonly path: string
  private cache: SessionTimestampMap = {}
  private loaded = false

  constructor(
    private readonly fileName: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = getGuiDataPath(fileName)
  }

  async has(sessionId: string): Promise<boolean> {
    await this.ensureLoaded()
    return sessionId in this.cache
  }

  async getAll(): Promise<SessionTimestampMap> {
    await this.ensureLoaded()
    return { ...this.cache }
  }

  /** True when the entry is new; an existing entry keeps its first timestamp. */
  async add(sessionId: string): Promise<boolean> {
    await this.ensureLoaded()
    if (sessionId in this.cache) return false
    this.cache[sessionId] = this.now()
    await this.save()
    return true
  }

  /** True when an entry was removed. */
  async remove(sessionId: string): Promise<boolean> {
    await this.ensureLoaded()
    if (!(sessionId in this.cache)) return false
    delete this.cache[sessionId]
    await this.save()
    return true
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      if (existsSync(this.path)) {
        this.cache = parseTimestampMap(JSON.parse(await readFile(this.path, 'utf-8')))
      }
    } catch {
      this.cache = {}
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    try {
      const dir = join(this.path, '..')
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
      await writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error(`Failed to save ${this.fileName}:`, err)
    }
  }
}
