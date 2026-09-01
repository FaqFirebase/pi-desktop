import { ipcMain } from 'electron'
import type { AgentEngineKind, ModelsFileInfo, ModelsReadResult } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  isModelsConfig,
  parseModelsFile,
  resolveModelsFile,
  serializeModelsFile,
  type ModelsFileLocation,
} from '../models-file'
import { activeEngineKind } from './active-engine'
import type { IpcContext } from './context'

function modelsFileLocation(engine: AgentEngineKind): ModelsFileLocation {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return resolveModelsFile(engine, homeDir)
}

function fileInfo(engine: AgentEngineKind, location: ModelsFileLocation): ModelsFileInfo {
  return { engine, file: location.file, name: location.name }
}

export async function readModelsConfigFile(engine: AgentEngineKind): Promise<ModelsReadResult> {
  const location = modelsFileLocation(engine)
  const info = fileInfo(engine, location)
  if (!existsSync(location.file)) return { config: { providers: {} }, location: info }
  let raw: string
  try {
    raw = await readFile(location.file, 'utf-8')
  } catch (err) {
    return {
      error: `Could not read ${location.name}: ${err instanceof Error ? err.message : String(err)}`,
      raw: '',
      location: info,
    }
  }
  try {
    const parsed = parseModelsFile(raw, location.format)
    if (!isModelsConfig(parsed)) {
      return { error: `${location.name} is not a valid models config (missing "providers")`, raw, location: info }
    }
    return { config: parsed, location: info }
  } catch (err) {
    const syntax = location.format === 'json' ? 'JSON' : 'YAML'
    return {
      error: `${location.name} is not valid ${syntax}: ${err instanceof Error ? err.message : String(err)}`,
      raw,
      location: info,
    }
  }
}

export function registerModelsConfigHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx

  ipcMain.handle(IPC_CHANNELS.MODELS_READ, async (): Promise<ModelsReadResult> => {
    return readModelsConfigFile(activeEngineKind(workspaceManager))
  })

  ipcMain.handle(IPC_CHANNELS.MODELS_WRITE, async (_event, config: unknown): Promise<{ success: boolean; error?: string }> => {
    if (!isModelsConfig(config)) {
      return { success: false, error: 'Invalid models config' }
    }
    const location = modelsFileLocation(activeEngineKind(workspaceManager))
    try {
      if (!existsSync(location.dir)) await mkdir(location.dir, { recursive: true })
      await writeFile(location.file, serializeModelsFile(config, location.format), 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
