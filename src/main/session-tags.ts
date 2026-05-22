import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * Session tags store.
 * Maps session IDs to arrays of tags.
 * Stored in ~/.pi-desktop-gui/session-tags.json
 */

const CONFIG_DIR_NAME = '.pi-desktop-gui'
const TAGS_FILE_NAME = 'session-tags.json'

interface TagsStore {
  [sessionId: string]: string[]
}

export class SessionTagManager {
  private tagsPath: string
  private cache: TagsStore = {}
  private loaded = false

  constructor() {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    this.tagsPath = join(homeDir, CONFIG_DIR_NAME, TAGS_FILE_NAME)
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
        .filter((t) => t.length > 0 && t.length <= 32)
    )]

    if (normalized.length === 0) {
      delete this.cache[sessionId]
    } else {
      this.cache[sessionId] = normalized
    }

    await this.save()
  }

  async addTag(sessionId: string, tag: string): Promise<string[]> {
    await this.ensureLoaded()
    const existing = this.cache[sessionId] ?? []
    const normalized = tag.trim().toLowerCase().replace(/^#/, '')
    if (normalized.length === 0 || normalized.length > 32) return existing
    if (existing.includes(normalized)) return existing

    this.cache[sessionId] = [...existing, normalized]
    await this.save()
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
