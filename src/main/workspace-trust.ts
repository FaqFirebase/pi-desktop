import { existsSync, mkdirSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { getGuiDataPath } from './app-data-paths'

/**
 * Workspace trust registry.
 *
 * A workspace's `.pi-desktop/permission-rules.json` can come from an untrusted
 * cloned repository. Its `allow` rules take effect only once the user trusts the
 * workspace (see loadEffectiveRules), and the HTML file preview only runs scripts
 * for a trusted workspace. Trust is keyed by resolved absolute path and persisted
 * as a JSON array of paths in the Electron userData directory.
 *
 * `isTrusted` is synchronous so it can be consulted from the two hot, sync paths
 * that gate on trust: building each Pi spawn's environment, and Electron's
 * `will-attach-webview` handler for the preview guest.
 */

const TRUST_FILE_NAME = 'trusted-workspaces.json'

export class WorkspaceTrustStore {
  private path: string
  private trusted = new Set<string>()
  private loaded = false

  constructor(filePath?: string) {
    this.path = filePath ?? getGuiDataPath(TRUST_FILE_NAME)
  }

  isTrusted(workspacePath: string): boolean {
    if (!workspacePath) return false
    this.ensureLoaded()
    return this.trusted.has(resolve(workspacePath))
  }

  getAll(): string[] {
    this.ensureLoaded()
    return [...this.trusted]
  }

  async trust(workspacePath: string): Promise<void> {
    if (!workspacePath) return
    this.ensureLoaded()
    const key = resolve(workspacePath)
    if (this.trusted.has(key)) return
    this.trusted.add(key)
    await this.save()
  }

  async revoke(workspacePath: string): Promise<void> {
    if (!workspacePath) return
    this.ensureLoaded()
    const key = resolve(workspacePath)
    if (!this.trusted.has(key)) return
    this.trusted.delete(key)
    await this.save()
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === 'string' && entry) this.trusted.add(resolve(entry))
          }
        }
      }
    } catch {
      this.trusted = new Set()
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    try {
      const dir = dirname(this.path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      await writeFile(this.path, JSON.stringify([...this.trusted], null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save trusted workspaces:', err)
    }
  }
}

/** Singleton used across the main process. */
export const workspaceTrustStore = new WorkspaceTrustStore()
