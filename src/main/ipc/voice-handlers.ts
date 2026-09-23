import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type {
  VoiceInstallRequest,
  VoiceProgressEvent,
  VoiceStatus,
} from '../../shared/ipc-contracts'
import { listVoiceModels, getVoiceModel, type VoicePrecision } from '../../shared/voice-models'
import { downloadVoiceModel } from '../voice-model-download'
import { voiceGpuRestartRequired } from '../voice-gpu-switches'
import { listInstalledVoiceModels, removeVoiceModel } from '../voice-model-store'
import { loadAppSettings, saveAppSettings } from './settings'
import { assertTrustedSender, isObject, isString } from './validation'
import { appLog } from '../app-log'
import type { IpcContext } from './context'

const VOICE_PRECISIONS: readonly VoicePrecision[] = ['int8', 'fp16']

function isVoicePrecision(value: unknown): value is VoicePrecision {
  return typeof value === 'string' && (VOICE_PRECISIONS as readonly string[]).includes(value)
}

export function registerVoiceHandlers(ctx: IpcContext): void {
  const { workspaceManager, broadcast } = ctx
  // One download at a time; its controller lets VOICE_CANCEL abort it.
  let activeInstall: { modelId: string; controller: AbortController } | null = null

  async function buildStatus(): Promise<VoiceStatus> {
    const settings = await loadAppSettings(workspaceManager)
    return {
      catalog: [...listVoiceModels()],
      installed: await listInstalledVoiceModels(),
      selectedModel: settings.voiceModel,
      selectedPrecision: settings.voicePrecision,
      device: settings.voiceDevice,
      restartRequired: voiceGpuRestartRequired(process.platform, settings.voiceDevice),
    }
  }

  ipcMain.handle(IPC_CHANNELS.VOICE_STATUS, async () => buildStatus())

  ipcMain.handle(IPC_CHANNELS.VOICE_INSTALL, async (event, request: unknown) => {
    assertTrustedSender(event)
    if (!isObject(request)) throw new Error('install request must be an object')
    const { modelId, precision } = request as Partial<VoiceInstallRequest>
    if (!isString(modelId)) throw new Error('modelId must be a string')
    if (!isVoicePrecision(precision)) throw new Error('precision must be int8 or fp16')
    const model = getVoiceModel(modelId)
    if (!model) throw new Error(`Unknown voice model: ${modelId}`)
    if (!model.precisions.includes(precision)) {
      throw new Error(`${modelId} does not offer precision ${precision}`)
    }

    activeInstall?.controller.abort()
    const controller = new AbortController()
    activeInstall = { modelId, controller }

    const emit = (event: VoiceProgressEvent) => broadcast(IPC_CHANNELS.EVENT_VOICE_PROGRESS, event)
    try {
      await downloadVoiceModel(model, precision, {
        signal: controller.signal,
        onProgress: (progress) =>
          emit({ modelId, precision, phase: 'downloading', progress }),
      })
      emit({
        modelId,
        precision,
        phase: 'done',
        progress: { completedFiles: 0, totalFiles: 0, receivedBytes: 0, totalBytes: null, currentFile: '' },
      })
      return buildStatus()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({
        modelId,
        precision,
        phase: 'error',
        progress: { completedFiles: 0, totalFiles: 0, receivedBytes: 0, totalBytes: null, currentFile: '' },
        error: message,
      })
      appLog.error('voice', `Install of ${modelId}/${precision} failed`, err)
      throw err
    } finally {
      if (activeInstall?.controller === controller) activeInstall = null
    }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_CANCEL, async (event) => {
    assertTrustedSender(event)
    activeInstall?.controller.abort()
    activeInstall = null
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_REMOVE, async (event, modelId: unknown) => {
    assertTrustedSender(event)
    if (!isString(modelId)) throw new Error('modelId must be a string')
    await removeVoiceModel(modelId)
    const settings = await loadAppSettings(workspaceManager)
    if (settings.voiceModel === modelId) {
      await saveAppSettings({ voiceModel: null })
    }
    return buildStatus()
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_SELECT, async (event, request: unknown) => {
    assertTrustedSender(event)
    if (!isObject(request)) throw new Error('select request must be an object')
    const { modelId, precision } = request as { modelId?: unknown; precision?: unknown }
    if (modelId !== null && !isString(modelId)) throw new Error('modelId must be a string or null')
    if (modelId !== null && !getVoiceModel(modelId)) throw new Error(`Unknown voice model: ${modelId}`)
    if (!isVoicePrecision(precision)) throw new Error('precision must be int8 or fp16')
    await saveAppSettings({ voiceModel: modelId, voicePrecision: precision })
    return buildStatus()
  })
}
