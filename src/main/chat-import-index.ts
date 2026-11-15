import { existsSync } from 'fs'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { AgentEngineKind } from '../shared/ipc-contracts'
import type { ChatImportSource } from '../shared/chat-import'
import { getGuiDataPath } from './app-data-paths'

/**
 * Chats already imported, per engine, in the GUI data dir. A chat counts as
 * imported while the session file it was written to still exists, so a
 * removed import can be imported again.
 */

export const CHAT_IMPORT_INDEX_FILE = 'chat-imports.json'
const CHAT_IMPORT_INDEX_VERSION = 1
const JSON_INDENT = 2
const TEMP_SUFFIX = '.tmp'

interface ChatImportIndexEntry {
  sessionPath: string
  importedAt: number
}

interface ChatImportIndexFile {
  version: number
  entries: Record<string, ChatImportIndexEntry>
}

export function chatImportKey(engine: AgentEngineKind, source: ChatImportSource, sourceSessionId: string): string {
  return `${engine}:${source}:${sourceSessionId}`
}

function parseEntries(value: unknown): Record<string, ChatImportIndexEntry> {
  const entries: Record<string, ChatImportIndexEntry> = {}
  if (typeof value !== 'object' || value === null) return entries
  for (const [key, entry] of Object.entries((value as { entries?: unknown }).entries ?? {})) {
    if (typeof entry !== 'object' || entry === null) continue
    const { sessionPath, importedAt } = entry as Partial<ChatImportIndexEntry>
    if (typeof sessionPath === 'string' && typeof importedAt === 'number') entries[key] = { sessionPath, importedAt }
  }
  return entries
}

export class ChatImportIndex {
  private entries: Record<string, ChatImportIndexEntry> | null = null

  constructor(private readonly filePath: string = getGuiDataPath(CHAT_IMPORT_INDEX_FILE)) {}

  /** The written session path when the key is indexed and that file still exists. */
  async importedPath(key: string): Promise<string | null> {
    const entry = (await this.load())[key]
    return entry && existsSync(entry.sessionPath) ? entry.sessionPath : null
  }

  async record(key: string, sessionPath: string): Promise<void> {
    const entries = await this.load()
    entries[key] = { sessionPath, importedAt: Date.now() }
    const file: ChatImportIndexFile = { version: CHAT_IMPORT_INDEX_VERSION, entries }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}${TEMP_SUFFIX}`
    await writeFile(tempPath, JSON.stringify(file, null, JSON_INDENT), 'utf8')
    await rename(tempPath, this.filePath)
  }

  private async load(): Promise<Record<string, ChatImportIndexEntry>> {
    if (this.entries) return this.entries
    try {
      this.entries = parseEntries(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch {
      // Missing or damaged: start empty; the next record rewrites the file.
      this.entries = {}
    }
    return this.entries
  }
}
