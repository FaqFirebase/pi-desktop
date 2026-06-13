import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { getGuiDataPath } from './app-data-paths'
import type { Note, NoteInput, NoteUpdate, NoteScope } from '../shared/ipc-contracts'

/**
 * Notes store — reusable prompts and agent commands.
 *
 * A single global store: every note carries a `scope` (`'global'` or a
 * workspace id) so the renderer can present a merged view of global notes plus
 * the active workspace's notes. Persisted to the GUI data directory, mirroring
 * the SessionTagManager pattern (lazy load, in-memory cache, errors logged).
 */

const NOTES_FILE_NAME = 'notes.json'

const GLOBAL_SCOPE: NoteScope = 'global'
const MAX_TITLE_LENGTH = 120
const MAX_BODY_LENGTH = 20000
const MAX_TAG_LENGTH = 32

interface NotesFile {
  notes: Note[]
}

/** Thrown when an update/remove targets a note id that doesn't exist. */
export class NoteNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Note not found: ${id}`)
    this.name = 'NoteNotFoundError'
  }
}

/** Thrown when create/update input fails validation. */
export class NoteValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoteValidationError'
  }
}

interface NormalizedFields {
  title: string
  body: string
  tags: string[]
  scope: NoteScope
}

export class NotesManager {
  private notesPath: string
  private cache: Note[] = []
  private loaded = false

  constructor() {
    this.notesPath = getGuiDataPath(NOTES_FILE_NAME)
  }

  async list(): Promise<Note[]> {
    await this.ensureLoaded()
    return this.cache.map((note) => ({ ...note }))
  }

  async create(input: NoteInput): Promise<Note> {
    await this.ensureLoaded()
    const fields = this.normalize(input)
    const now = Date.now()
    const note: Note = {
      id: randomUUID(),
      ...fields,
      createdAt: now,
      updatedAt: now,
    }
    this.cache.push(note)
    await this.save()
    return { ...note }
  }

  async update(id: string, patch: NoteUpdate): Promise<Note> {
    await this.ensureLoaded()
    const index = this.cache.findIndex((note) => note.id === id)
    if (index === -1) throw new NoteNotFoundError(id)

    const current = this.cache[index]
    // Validate the merged result so partial updates are checked the same way.
    const fields = this.normalize({
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      tags: patch.tags ?? current.tags,
      scope: patch.scope ?? current.scope,
    })

    const updated: Note = {
      ...current,
      ...fields,
      updatedAt: Date.now(),
    }
    this.cache[index] = updated
    await this.save()
    return { ...updated }
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    const index = this.cache.findIndex((note) => note.id === id)
    if (index === -1) throw new NoteNotFoundError(id)
    this.cache.splice(index, 1)
    await this.save()
  }

  /**
   * Reassign every note scoped to `workspaceId` back to global so notes never
   * orphan on a deleted workspace. Called when a workspace is removed.
   */
  async reassignToGlobal(workspaceId: string): Promise<void> {
    await this.ensureLoaded()
    let changed = false
    const now = Date.now()
    for (const note of this.cache) {
      if (note.scope === workspaceId) {
        note.scope = GLOBAL_SCOPE
        note.updatedAt = now
        changed = true
      }
    }
    if (changed) await this.save()
  }

  private normalize(input: NoteInput): NormalizedFields {
    const title = input.title.trim()
    if (title.length === 0) throw new NoteValidationError('Note title is required')
    const body = input.body.trim()
    if (body.length === 0) throw new NoteValidationError('Note body is required')

    const scope = typeof input.scope === 'string' && input.scope.trim().length > 0
      ? input.scope.trim()
      : GLOBAL_SCOPE

    const tags = [...new Set(
      input.tags
        .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
        .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH)
    )]

    return {
      title: title.slice(0, MAX_TITLE_LENGTH),
      body: body.slice(0, MAX_BODY_LENGTH),
      tags,
      scope,
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return

    try {
      if (existsSync(this.notesPath)) {
        const data = await readFile(this.notesPath, 'utf-8')
        const parsed = JSON.parse(data) as Partial<NotesFile>
        this.cache = Array.isArray(parsed.notes) ? parsed.notes : []
      }
    } catch {
      this.cache = []
    }

    this.loaded = true
  }

  private async save(): Promise<void> {
    try {
      const dir = join(this.notesPath, '..')
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
      const store: NotesFile = { notes: this.cache }
      await writeFile(this.notesPath, JSON.stringify(store, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save notes:', err)
    }
  }
}
