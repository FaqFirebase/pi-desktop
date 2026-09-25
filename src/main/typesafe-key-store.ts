import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { dirname } from 'path'
import { TYPESAFE_API_KEY_ENV, normalizeTypeSafeApiKey } from '../shared/typesafe'
import { getGuiDataPath } from './app-data-paths'

const TYPESAFE_KEY_FILE = 'typesafe-api-key'
const OWNER_ONLY_MODE = 0o600

/**
 * The user's TypeSafe API key, in its own owner-only file in the GUI data
 * directory — the same protection Pi gives its own provider keys in
 * `auth.json`. It works alike on every platform with no OS keychain, so there
 * is no signing requirement and no permission prompt after updates.
 *
 * The key never goes into settings.json and is never sent to the renderer.
 */
export class TypeSafeKeyStore {
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
    const key = normalizeTypeSafeApiKey(raw)
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
      return normalizeTypeSafeApiKey(readFileSync(this.resolvePath(), 'utf8'))
    } catch {
      return null
    }
  }
}

/** The app's one key store. The path resolves on use: the data directory is configured during startup. */
export const typeSafeKeyStore = new TypeSafeKeyStore(() => getGuiDataPath(TYPESAFE_KEY_FILE))

/**
 * The environment additions that give an agent process the saved key. A key
 * already set in the inherited environment wins, so a developer's shell value
 * is never overridden.
 */
export function typeSafeKeyEnv(
  savedKey: string | null,
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!savedKey || inherited[TYPESAFE_API_KEY_ENV]) return {}
  return { [TYPESAFE_API_KEY_ENV]: savedKey }
}
