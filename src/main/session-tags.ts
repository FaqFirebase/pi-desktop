import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { deriveAutoTag } from './auto-tag'

/**
 * Session tags store.
 * Maps session IDs to arrays of tags.
 * Stored in ~/.pi-desktop-gui/session-tags.json
 */

const CONFIG_DIR_NAME = '.pi-desktop-gui'
const TAGS_FILE_NAME = 'session-tags.json'
const AUTO_TAGS_FILE_NAME = 'session-auto-tags.json'
const MAX_TAG_LENGTH = 32

interface TagsStore {
  [sessionId: string]: string[]
}

/**
 * On-disk shape for machine-derived tags. `tags` holds the currently assigned
 * auto-tag per session; `processed` records every session we've already
 * attempted, so a removed auto-tag is never re-derived on the next load.
 */
interface AutoTagsStore {
  tags: Record<string, string>
  processed: string[]
}

export class SessionTagManager {
  private tagsPath: string
  private cache: TagsStore = {}
  private loaded = false

  private autoTagsPath: string
  private autoTags: Record<string, string> = {}
  private autoProcessed = new Set<string>()
  private autoLoaded = false

  constructor() {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    this.tagsPath = join(homeDir, CONFIG_DIR_NAME, TAGS_FILE_NAME)
    this.autoTagsPath = join(homeDir, CONFIG_DIR_NAME, AUTO_TAGS_FILE_NAME)
  }

  async getTags(sessionId: string): Promise<string[]> {
    await this.ensureLoaded()
    return this.cache[sessionId] ?? []
  }

  async getAllTags(): Promise<TagsStore> {
    await this.ensureLoaded()
    return { ...this.cache }
  }

  async setTags(sessionId: string, tags: string[]): Promise<void> {
    await this.ensureLoaded()
    // Normalize: lowercase, trim, remove empties, dedupe
    const normalized = [...new Set(
      tags
        .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
        .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH)
    )]

    if (normalized.length === 0) {
      delete this.cache[sessionId]
    } else {
      this.cache[sessionId] = normalized
      // Manual tags supersede the auto-tag; drop it but keep processed.
      await this.clearAutoTag(sessionId, true)
    }

    await this.save()
  }

  async addTag(sessionId: string, tag: string): Promise<string[]> {
    await this.ensureLoaded()
    const existing = this.cache[sessionId] ?? []
    const normalized = tag.trim().toLowerCase().replace(/^#/, '')
    if (normalized.length === 0 || normalized.length > MAX_TAG_LENGTH) return existing
    if (existing.includes(normalized)) return existing

    this.cache[sessionId] = [...existing, normalized]
    await this.save()
    // A manual tag supersedes the auto-tag; drop it but keep the session marked
    // processed so it isn't re-derived later.
    await this.clearAutoTag(sessionId, true)
    return this.cache[sessionId]
  }

  async removeTag(sessionId: string, tag: string): Promise<string[]> {
    await this.ensureLoaded()
    const existing = this.cache[sessionId] ?? []
    const normalized = tag.trim().toLowerCase().replace(/^#/, '')
    this.cache[sessionId] = existing.filter((t) => t !== normalized)

    if (this.cache[sessionId].length === 0) {
      delete this.cache[sessionId]
    }

    await this.save()
    return this.cache[sessionId] ?? []
  }

  async getSessionsWithTag(tag: string): Promise<string[]> {
    await this.ensureLoaded()
    const normalized = tag.trim().toLowerCase().replace(/^#/, '')
    const sessionIds: string[] = []

    for (const [sessionId, tags] of Object.entries(this.cache)) {
      if (tags.includes(normalized)) {
        sessionIds.push(sessionId)
      }
    }

    return sessionIds
  }

  async getAllUsedTags(): Promise<string[]> {
    await this.ensureLoaded()
    const allTags = new Set<string>()
    for (const tags of Object.values(this.cache)) {
      for (const tag of tags) {
        allTags.add(tag)
      }
    }
    return [...allTags].sort()
  }

  // ─── Auto-tags ──────────────────────────────────────────────────────────

  async getAutoTags(): Promise<Record<string, string>> {
    await this.ensureAutoLoaded()
    return { ...this.autoTags }
  }

  /**
   * For each supplied session, derive and persist an auto-tag when it has no
   * manual tags and hasn't been processed before. Returns the full auto-tag map.
   */
  async ensureAutoTags(sessions: Array<{ sessionId: string; path: string }>): Promise<Record<string, string>> {
    await this.ensureLoaded()
    await this.ensureAutoLoaded()

    let changed = false
    for (const { sessionId, path } of sessions) {
      if (this.autoProcessed.has(sessionId)) continue
      if ((this.cache[sessionId]?.length ?? 0) > 0) continue

      const derived = await deriveAutoTag(path)
      this.autoProcessed.add(sessionId)
      if (derived) {
        const normalized = derived.trim().toLowerCase().replace(/^#/, '')
        if (normalized.length > 0 && normalized.length <= MAX_TAG_LENGTH) {
          this.autoTags[sessionId] = normalized
        }
      }
      changed = true
    }

    if (changed) await this.saveAuto()
    return { ...this.autoTags }
  }

  /** Remove an auto-tag at the user's request; stays processed so it won't return. */
  async removeAutoTag(sessionId: string): Promise<void> {
    await this.clearAutoTag(sessionId, true)
  }

  /** Forget a session entirely (used when the session is deleted). */
  async forgetAuto(sessionId: string): Promise<void> {
    await this.clearAutoTag(sessionId, false)
  }

  private async clearAutoTag(sessionId: string, keepProcessed: boolean): Promise<void> {
    await this.ensureAutoLoaded()
    let changed = false
    if (sessionId in this.autoTags) {
      delete this.autoTags[sessionId]
      changed = true
    }
    if (keepProcessed) {
      if (!this.autoProcessed.has(sessionId)) {
        this.autoProcessed.add(sessionId)
        changed = true
      }
    } else if (this.autoProcessed.delete(sessionId)) {
      changed = true
    }
    if (changed) await this.saveAuto()
  }

  private async ensureAutoLoaded(): Promise<void> {
    if (this.autoLoaded) return

    try {
      if (existsSync(this.autoTagsPath)) {
        const data = await readFile(this.autoTagsPath, 'utf-8')
        const parsed = JSON.parse(data) as Partial<AutoTagsStore>
        this.autoTags = parsed.tags ?? {}
        this.autoProcessed = new Set(parsed.processed ?? [])
      }
    } catch {
      this.autoTags = {}
      this.autoProcessed = new Set()
    }

    this.autoLoaded = true
  }

  private async saveAuto(): Promise<void> {
    try {
      const dir = join(this.autoTagsPath, '..')
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
      const store: AutoTagsStore = {
        tags: this.autoTags,
        processed: [...this.autoProcessed],
      }
      await writeFile(this.autoTagsPath, JSON.stringify(store, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save session auto-tags:', err)
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return

    try {
      if (existsSync(this.tagsPath)) {
        const data = await readFile(this.tagsPath, 'utf-8')
        this.cache = JSON.parse(data)
      }
    } catch {
      this.cache = {}
    }

    this.loaded = true
  }

  private async save(): Promise<void> {
    try {
      const dir = join(this.tagsPath, '..')
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
      await writeFile(this.tagsPath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save session tags:', err)
    }
  }
}
