import type { VoiceModel, VoicePrecision } from '../../../shared/voice-models'
import {
  parakeetFileUrls,
  transformersDtype,
  VOICE_MODEL_BASE_URL,
} from '../../../shared/voice-engine-config'
import { createSerialRunner } from '../../../shared/serial-runner'
import { runtimeForPrecision } from '../../../shared/voice-device'
import {
  VOICE_NEEDS_GPU_ERROR,
  voiceEngineKey,
  type TranscribeRequest,
  type TranscribeResponse,
} from './voice-worker-protocol'
import { GPU_POWER_PREFERENCE, probeGpu } from './gpu-probe'

// Runs the speech models in a Web Worker, so a model run never blocks the page:
// the mic button and the composer stay responsive while it works.

type TranscribeFn = (audio: Float32Array) => Promise<string>

interface LoadedEngine {
  key: string
  transcribe: TranscribeFn
}

let loaded: LoadedEngine | null = null

// onnxruntime rejects a second run on a session while one is in flight
// ("Session already started"), so every load and inference goes through one
// queue. A failed load leaves `loaded` unchanged, so the next call retries.
const runExclusive = createSerialRunner()

// parakeet.js only sets GPU execution providers for its 'webgpu-hybrid' and
// 'webgpu-strict' modes; plain 'webgpu' leaves the list empty and runs on WASM.
// Hybrid runs the encoder (the heavy part) on the GPU and the decoder on WASM.
const PARAKEET_GPU_BACKEND = 'webgpu-hybrid'

/**
 * The installed precision decides where the model runs (see voice-device.ts):
 * fp16 on the GPU, int8 on the CPU. fp16 cannot run on the CPU, so it fails
 * with a clear message when no hardware GPU is found.
 */
async function resolveDevice(precision: VoicePrecision): Promise<'webgpu' | 'wasm'> {
  if (runtimeForPrecision(precision) === 'cpu') return 'wasm'
  if (!(await probeGpu()).available) throw new Error(VOICE_NEEDS_GPU_ERROR)
  return 'webgpu'
}

async function loadTransformers(
  model: VoiceModel,
  precision: VoicePrecision,
  wasmBaseUrl: string,
): Promise<TranscribeFn> {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = VOICE_MODEL_BASE_URL
  const wasmBackend = env.backends?.onnx?.wasm
  if (wasmBackend) wasmBackend.wasmPaths = wasmBaseUrl
  const webgpuBackend = env.backends?.onnx?.webgpu
  if (webgpuBackend) webgpuBackend.powerPreference = GPU_POWER_PREFERENCE

  const asr = await pipeline('automatic-speech-recognition', model.id, {
    dtype: transformersDtype(precision) as 'q8' | 'fp16',
    device: await resolveDevice(precision),
  })

  return async (audio: Float32Array) => {
    const output = await asr(audio)
    const result = Array.isArray(output) ? output[0] : output
    return typeof result?.text === 'string' ? result.text.trim() : ''
  }
}

async function loadParakeet(
  model: VoiceModel,
  precision: VoicePrecision,
  wasmBaseUrl: string,
): Promise<TranscribeFn> {
  const [{ fromUrls }, ort] = await Promise.all([
    import('parakeet.js'),
    import('onnxruntime-web'),
  ])
  ort.env.wasm.wasmPaths = wasmBaseUrl

  const parakeet = await fromUrls({
    ...parakeetFileUrls(model.id, precision),
    backend: (await resolveDevice(precision)) === 'webgpu' ? PARAKEET_GPU_BACKEND : 'wasm',
    preprocessorBackend: 'onnx',
  })

  return async (audio: Float32Array) => {
    const result = await parakeet.transcribe(audio, 16000, {})
    return typeof result?.utterance_text === 'string' ? result.utterance_text.trim() : ''
  }
}

async function loadEngine({ model, precision, wasmBaseUrl }: TranscribeRequest): Promise<LoadedEngine> {
  const transcribe =
    model.engine === 'parakeet'
      ? await loadParakeet(model, precision, wasmBaseUrl)
      : await loadTransformers(model, precision, wasmBaseUrl)
  return { key: voiceEngineKey(model.id, precision), transcribe }
}

function transcribe(request: TranscribeRequest): Promise<string> {
  return runExclusive(async () => {
    const key = voiceEngineKey(request.model.id, request.precision)
    if (loaded?.key !== key) loaded = await loadEngine(request)
    return loaded.transcribe(request.audio)
  })
}

self.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
  const { id } = event.data
  let response: TranscribeResponse
  try {
    response = { id, text: await transcribe(event.data) }
  } catch (err) {
    response = { id, error: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(response)
}
