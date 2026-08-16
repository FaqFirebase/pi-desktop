import { ipcMain } from 'electron'
import type { ModelsConfig, ModelsReadResult } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

/** Read `~/.pi/agent/models.json`; also consumed by the diagnostics report. */
export async function readModelsConfigFile(): Promise<ModelsReadResult> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const file = join(homeDir, '.pi', 'agent', 'models.json')
  if (!existsSync(file)) return { config: { providers: {} } }
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch (err) {
    return { error: `Could not read models.json: ${err instanceof Error ? err.message : String(err)}`, raw: '' }
  }
  try {
    const parsed = JSON.parse(raw) as ModelsConfig
    // typeof null is 'object' and arrays pass typeof too — both would blow up
    // every consumer iterating providers as a record.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.providers !== 'object' ||
      parsed.providers === null ||
      Array.isArray(parsed.providers)
    ) {
      return { error: 'models.json is not a valid models config (missing "providers")', raw }
    }
    return { config: parsed }
  } catch (err) {
    return { error: `models.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, raw }
  }
}

export function registerModelsConfigHandlers(): void {
  // ─── Models Config ──────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.MODELS_READ, async (): Promise<ModelsReadResult> => {
    return readModelsConfigFile()
  })

  ipcMain.handle(IPC_CHANNELS.MODELS_WRITE, async (_event, config: unknown): Promise<{ success: boolean; error?: string }> => {
    const providers = (config as ModelsConfig | null)?.providers
    if (
      typeof config !== 'object' ||
      config === null ||
      typeof providers !== 'object' ||
      providers === null ||
      Array.isArray(providers)
    ) {
      return { success: false, error: 'Invalid models config' }
    }
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const dir = join(homeDir, '.pi', 'agent')
    const file = join(dir, 'models.json')
    try {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
