import { ipcMain } from 'electron'
import type { ModelsReadResult } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { getPiCli } from '../pi-rpc-manager'
import {
  isModelsConfig,
  parseModelsFile,
  resolveModelsFile,
  serializeModelsFile,
  type ModelsFileLocation,
} from '../models-file'

function modelsFileLocation(): ModelsFileLocation {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return resolveModelsFile(getPiCli().kind === 'omp' ? 'omp' : 'pi', homeDir)
}

export async function readModelsConfigFile(): Promise<ModelsReadResult> {
  const location = modelsFileLocation()
  if (!existsSync(location.file)) return { config: { providers: {} } }
  let raw: string
  try {
    raw = await readFile(location.file, 'utf-8')
  } catch (err) {
    return { error: `Could not read ${location.name}: ${err instanceof Error ? err.message : String(err)}`, raw: '' }
  }
  try {
    const parsed = parseModelsFile(raw, location.format)
    if (!isModelsConfig(parsed)) {
      return { error: `${location.name} is not a valid models config (missing "providers")`, raw }
    }
    return { config: parsed }
  } catch (err) {
    const syntax = location.format === 'json' ? 'JSON' : 'YAML'
    return { error: `${location.name} is not valid ${syntax}: ${err instanceof Error ? err.message : String(err)}`, raw }
  }
}

export function registerModelsConfigHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MODELS_READ, async (): Promise<ModelsReadResult> => {
    return readModelsConfigFile()
  })

  ipcMain.handle(IPC_CHANNELS.MODELS_WRITE, async (_event, config: unknown): Promise<{ success: boolean; error?: string }> => {
    if (!isModelsConfig(config)) {
      return { success: false, error: 'Invalid models config' }
    }
    const location = modelsFileLocation()
    try {
      if (!existsSync(location.dir)) await mkdir(location.dir, { recursive: true })
      await writeFile(location.file, serializeModelsFile(config, location.format), 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
