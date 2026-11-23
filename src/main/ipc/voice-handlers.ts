import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type {
  VoiceInstallRequest,
  VoiceProgressEvent,
  VoiceSaveServerKeyResult,
  VoiceStatus,
} from '../../shared/ipc-contracts'
import { listVoiceModels, getVoiceModel, type VoicePrecision } from '../../shared/voice-models'
import { MAX_RECORDING_MS, TARGET_SAMPLE_RATE } from '../../shared/voice-audio'
import { downloadVoiceModel } from '../voice-model-download'
import { voiceGpuRestartRequired } from '../voice-gpu-switches'
import { listInstalledVoiceModels, removeVoiceModel } from '../voice-model-store'
import { transcribeWithServer, voiceServerKeyStore } from '../voice-server-transcription'
import { createSerialQueue } from '../serial-queue'
import { loadAppSettings, saveAppSettings } from './settings'
import { assertTrustedSender, isObject, isString } from './validation'
import { appLog } from '../app-log'
import type { IpcContext } from './context'

const VOICE_PRECISIONS: readonly VoicePrecision[] = ['int8', 'fp16']
const MS_PER_SECOND = 1000
// A recording stops at the first level check past MAX_RECORDING_MS; the margin covers that check.
const CLIP_MARGIN_MS = 1000
const MAX_CLIP_SAMPLES = TARGET_SAMPLE_RATE * (MAX_RECORDING_MS + CLIP_MARGIN_MS) / MS_PER_SECOND

// Like the on-device worker, the server gets one segment at a time, in call order.
const runTranscription = createSerialQueue()

function isVoicePrecision(value: unknown): value is VoicePrecision {
  return typeof value === 'string' && (VOICE_PRECISIONS as readonly string[]).includes(value)
}

/** The same settings/catalog snapshot is used by main and restricted chat views. */
export async function buildVoiceStatus(workspaceManager: IpcContext['workspaceManager']): Promise<VoiceStatus> {
  const settings = await loadAppSettings(workspaceManager)
  return {
    catalog: [...listVoiceModels()],
    installed: await listInstalledVoiceModels(),
    selectedModel: settings.voiceModel,
    selectedPrecision: settings.voicePrecision,
    device: settings.voiceDevice,
    restartRequired: voiceGpuRestartRequired(process.platform, settings.voiceDevice),
    transcriber: settings.voiceTranscriber,
    server: settings.voiceServer,
    serverKeySaved: await serverKeySaved(),
  }
}

/** Whether a usable key is saved. A key file that cannot be read must not stop the status, and so all of dictation, from loading. */
async function serverKeySaved(): Promise<boolean> {
  try {
    return (await voiceServerKeyStore.readSavedKey()) !== null
  } catch (err) {
    appLog.warn('voice', 'Speech server key file cannot be read', err)
    return false
  }
}

/** The IPC payload of one segment: mono 16 kHz samples, never empty, never longer than a recording can be. */
export function parseVoiceClip(value: unknown): Float32Array {
  if (!(value instanceof Float32Array)) throw new Error('audio must be a Float32Array')
  if (value.length === 0 || value.length > MAX_CLIP_SAMPLES) throw new Error('audio length is out of range')
  return value
}

/** Transcribe one segment on the server in the settings. Main and Quick Chat windows share this path. */
export async function transcribeVoiceClip(
  workspaceManager: IpcContext['workspaceManager'],
  audio: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const clip = parseVoiceClip(audio)
  return runTranscription(async () => {
    const settings = await loadAppSettings(workspaceManager)
    try {
      const apiKey = await voiceServerKeyStore.readSavedKey()
      return await transcribeWithServer({ server: settings.voiceServer, apiKey, audio: clip }, fetchImpl)
    } catch (err) {
      appLog.warn('voice', 'Speech server transcription failed', err)
      throw err
    }
  })
}

export function registerVoiceHandlers(ctx: IpcContext): void {
  const { workspaceManager, broadcast } = ctx
  // One download at a time; its controller lets VOICE_CANCEL abort it.
  let activeInstall: { modelId: string; controller: AbortController } | null = null

  const buildStatus = (): Promise<VoiceStatus> => buildVoiceStatus(workspaceManager)

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

  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, async (event, audio: unknown) => {
    assertTrustedSender(event)
    return transcribeVoiceClip(workspaceManager, audio)
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_SAVE_SERVER_KEY, async (event, key: unknown): Promise<VoiceSaveServerKeyResult> => {
    assertTrustedSender(event)
    if (!(await voiceServerKeyStore.save(key))) return { ok: false }
    return { ok: true, status: await buildStatus() }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_CLEAR_SERVER_KEY, async (event) => {
    assertTrustedSender(event)
    await voiceServerKeyStore.clear()
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
