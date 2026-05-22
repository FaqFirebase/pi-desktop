import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * Archived-session registry.
 *
 * PI itself has no archive concept (see MEMORY.md → "PI does not expose
 * session deletion via RPC. PI does not have session archiving at all").
 * Archive is therefore a GUI-only annotation stored alongside session-tags.
 *
 * Shape on disk: { "<sessionId>": <archivedAtEpochMs> }
 * Path: ~/.pi-desktop-gui/archived-sessions.json
 *
 * The session ID is the file basename without `.jsonl` — matches the keys
 * used by SessionTagManager.
 */

const CONFIG_DIR_NAME = '.pi-desktop-gui'
const ARCHIVED_FILE_NAME = 'archived-sessions.json'

type ArchiveStore = Record<string, number>

export class ArchivedSessionsManager {
  private path: string
  private cache: ArchiveStore = {}
  private loaded = false

  constructor() {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    this.path = join(homeDir, CONFIG_DIR_NAME, ARCHIVED_FILE_NAME)
  }

  async isArchived(sessionId: string): Promise<boolean> {
    await this.ensureLoaded()
    return sessionId in this.cache
  }

  async getAll(): Promise<ArchiveStore> {
    await this.ensureLoaded()
    return { ...this.cache }
  }

  async archive(sessionId: string): Promise<void> {
    await this.ensureLoaded()
    if (sessionId in this.cache) return
    this.cache[sessionId] = Date.now()
    await this.save()
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.ensureLoaded()
    if (!(sessionId in this.cache)) return
    delete this.cache[sessionId]
    await this.save()
  }

  /**
   * Drop the entry for a session that no longer exists (called after delete
   * so the registry doesn't accumulate stale IDs).
   */
  async forget(sessionId: string): Promise<void> {
    await this.ensureLoaded()
    if (!(sessionId in this.cache)) return
    delete this.cache[sessionId]
    await this.save()
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      if (existsSync(this.path)) {
        const data = await readFile(this.path, 'utf-8')
        const parsed = JSON.parse(data) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.cache = parsed as ArchiveStore
        }
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
      console.error('Failed to save archived sessions:', err)
    }
  }
}
