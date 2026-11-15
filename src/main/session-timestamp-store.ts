import { readFile } from 'fs/promises'
import { appLog } from './app-log'
import { getGuiDataPath } from './app-data-paths'
import { writeJsonFileAtomic } from './atomic-file-write'

/** Log scope of the session registries and their wiring. */
export const SESSIONS_LOG_SCOPE = 'sessions'

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
  private loading: Promise<SessionTimestampMap> | null = null
  // Saves run one at a time, each writing the latest map.
  private saving: Promise<boolean> = Promise.resolve(true)

  constructor(
    private readonly fileName: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = getGuiDataPath(fileName)
  }

  async has(sessionId: string): Promise<boolean> {
    return sessionId in (await this.load())
  }

  async getAll(): Promise<SessionTimestampMap> {
    return { ...(await this.load()) }
  }

  /** True when the entry is new and saved; an existing entry keeps its first timestamp. */
  async add(sessionId: string): Promise<boolean> {
    const cache = await this.load()
    if (sessionId in cache) return false
    cache[sessionId] = this.now()
    if (await this.save()) return true
    delete cache[sessionId]
    return false
  }

  /** True when an entry was removed and the removal saved. */
  async remove(sessionId: string): Promise<boolean> {
    const cache = await this.load()
    if (!(sessionId in cache)) return false
    const timestamp = cache[sessionId]
    delete cache[sessionId]
    if (await this.save()) return true
    cache[sessionId] = timestamp
    return false
  }

  private load(): Promise<SessionTimestampMap> {
    this.loading ??= readFile(this.path, 'utf-8')
      .then((text) => parseTimestampMap(JSON.parse(text)))
      // Missing or damaged: start empty; the next save repairs the file.
      .catch(() => ({}))
    return this.loading
  }

  private save(): Promise<boolean> {
    this.saving = this.saving.then(async () => {
      try {
        await writeJsonFileAtomic(this.path, await this.load())
        return true
      } catch (err) {
        appLog.warn(SESSIONS_LOG_SCOPE, `Failed to save ${this.fileName}`, err)
        return false
      }
    })
    return this.saving
  }
}
