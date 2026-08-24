import { ipcMain } from 'electron'
import type { ModelsConfig, ModelsReadResult } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { getPiCli } from '../pi-rpc-manager'

function modelsConfigPaths(): { dir: string; file: string } {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const root = getPiCli().kind === 'omp' ? join(homeDir, '.omp', 'agent') : join(homeDir, '.pi', 'agent')
  return { dir: root, file: join(root, 'models.json') }
}

export async function readModelsConfigFile(): Promise<ModelsReadResult> {
  const { file } = modelsConfigPaths()
  if (!existsSync(file)) return { config: { providers: {} } }
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch (err) {
    return { error: `Could not read models.json: ${err instanceof Error ? err.message : String(err)}`, raw: '' }
  }
  try {
    const parsed = JSON.parse(raw) as ModelsConfig
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
    const { dir, file } = modelsConfigPaths()
    try {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
