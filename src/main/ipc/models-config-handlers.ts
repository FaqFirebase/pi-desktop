import { ipcMain } from 'electron'
import type { AgentEngineKind, ModelsFileInfo, ModelsReadFailure, ModelsReadResult } from '../../shared/ipc-contracts'
import { IPC_CHANNELS, isAgentEngineKind } from '../../shared/ipc-contracts'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  describeModelsReadFailure,
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

function failed(
  location: ModelsFileLocation,
  info: ModelsFileInfo,
  failure: ModelsReadFailure,
  raw: string,
): ModelsReadResult {
  return { error: describeModelsReadFailure(location.name, failure), failure, raw, location: info }
}

export async function readModelsConfigFile(engine: AgentEngineKind): Promise<ModelsReadResult> {
  const location = modelsFileLocation(engine)
  const info = fileInfo(engine, location)
  if (!existsSync(location.file)) return { config: { providers: {} }, location: info }
  let raw: string
  try {
    raw = await readFile(location.file, 'utf-8')
  } catch (err) {
    return failed(location, info, { kind: 'unreadable', detail: err instanceof Error ? err.message : String(err) }, '')
  }
  try {
    const parsed = parseModelsFile(raw, location.format)
    if (!isModelsConfig(parsed)) {
      return failed(location, info, { kind: 'missing-providers' }, raw)
    }
    return { config: parsed, location: info }
  } catch (err) {
    return failed(location, info, {
      kind: 'invalid-syntax',
      format: location.format,
      detail: err instanceof Error ? err.message : String(err),
    }, raw)
  }
}

export function registerModelsConfigHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx

  ipcMain.handle(IPC_CHANNELS.MODELS_READ, async (): Promise<ModelsReadResult> => {
    return readModelsConfigFile(activeEngineKind(workspaceManager))
  })

  ipcMain.handle(IPC_CHANNELS.MODELS_WRITE, async (_event, config: unknown, engine: unknown): Promise<{ success: boolean; error?: string }> => {
    if (!isModelsConfig(config)) {
      return { success: false, error: 'Invalid models config' }
    }
    // The editor names the engine whose file it read. The engine in use can
    // change while the editor is open, and resolving it again here would put
    // one engine's providers into the other's file.
    if (!isAgentEngineKind(engine)) {
      return { success: false, error: 'Invalid models engine' }
    }
    const location = modelsFileLocation(engine)
    try {
      if (!existsSync(location.dir)) await mkdir(location.dir, { recursive: true })
      await writeFile(location.file, serializeModelsFile(config, location.format), 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
