import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { dirname } from 'path'

const OWNER_ONLY_MODE = 0o600

export const MAX_API_KEY_LENGTH = 512

// A key is one token: printable ASCII with no spaces. Anything else is a paste
// accident, and a newline would corrupt the environment it is passed through.
const API_KEY_PATTERN = /^[\x21-\x7e]+$/

/** The trimmed key, or null when the value cannot be an API key. */
export function normalizeApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (key.length === 0 || key.length > MAX_API_KEY_LENGTH) return null
  return API_KEY_PATTERN.test(key) ? key : null
}

/**
 * An API key in its own owner-only file in the GUI data directory — the same
 * protection Pi gives its own provider keys in `auth.json`. It works alike on
 * every platform with no OS keychain, so there is no signing requirement and
 * no permission prompt after updates.
 *
 * The key never goes into settings.json and is never sent to the renderer.
 */
export class ApiKeyStore {
  // undefined until the first read; null when no usable key is saved.
  private cached: string | null | undefined

  constructor(private readonly resolvePath: () => string) {}

  /**
   * Synchronous because it runs while building a Pi process environment. The
   * file is read once and cached; save and clear keep the cache current.
   */
  getSavedKey(): string | null {
    if (this.cached === undefined) this.cached = this.readFromDisk()
    return this.cached
  }

  /** Save the key. Returns false, writing nothing, when the value cannot be an API key. */
  async save(raw: unknown): Promise<boolean> {
    const key = normalizeApiKey(raw)
    if (!key) return false

    const path = this.resolvePath()
    const tempPath = `${path}.${process.pid}.tmp`
    await mkdir(dirname(path), { recursive: true })
    // A fresh temp file is created owner-only and renamed over the target, so
    // the key is never readable by others, even for a moment, and a crash
    // never leaves half a key.
    try {
      await writeFile(tempPath, `${key}\n`, { mode: OWNER_ONLY_MODE })
      await rename(tempPath, path)
    } catch (err) {
      // Never leave a stray copy of the key behind.
      await rm(tempPath, { force: true })
      throw err
    }
    this.cached = key
    return true
  }

  async clear(): Promise<void> {
    await rm(this.resolvePath(), { force: true })
    this.cached = null
  }

  private readFromDisk(): string | null {
    try {
      return normalizeApiKey(readFileSync(this.resolvePath(), 'utf8'))
    } catch {
      return null
    }
  }
}
