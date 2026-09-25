import type { VoiceModel, VoicePrecision } from '../../../shared/voice-models'
import { voiceEngineKey, type TranscribeRequest, type TranscribeResponse } from './voice-worker-protocol'

// Where onnxruntime-web loads its WebAssembly runtime from. The build copies the
// files here and the dev server serves them (see voiceWasmPlugin). Loading them
// locally keeps speech-to-text offline and within the locked CSP.
const WASM_BASE_URL = new URL('voice-wasm/', document.baseURI).href

interface PendingRequest {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
// Model and precision the current worker has loaded (or will load next).
let workerEngineKey: string | null = null
let nextRequestId = 0
const pending = new Map<number, PendingRequest>()

function failAll(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

/**
 * The worker for `engineKey`. A worker keeps its loaded model until it ends,
 * and an ONNX session holds its memory (up to about 1.3 GB) even after the
 * worker drops it, so a different model or precision gets a fresh worker once
 * nothing is pending on the old one.
 */
function getWorker(engineKey: string): Worker {
  if (worker && workerEngineKey !== engineKey && pending.size === 0) {
    worker.terminate()
    worker = null
  }
  workerEngineKey = engineKey
  if (worker) return worker
  const created = new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (event: MessageEvent<TranscribeResponse>) => {
    const response = event.data
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if ('error' in response) request.reject(new Error(response.error))
    else request.resolve(response.text)
  }
  // A worker that fails to start or crashes cannot answer; drop it so the next
  // call starts a fresh one.
  created.onerror = (event) => {
    event.preventDefault()
    created.terminate()
    if (worker === created) worker = null
    failAll(new Error(event.message || 'Voice worker failed'))
  }
  worker = created
  return created
}

/**
 * Transcribe mono 16 kHz PCM with the chosen model. The model runs in a Web
 * Worker, which loads and caches the engine on first use and reloads it when
 * the model or precision changes. Calls run one at a time, in call order.
 */
export function transcribeAudio(
  audio: Float32Array,
  model: VoiceModel,
  precision: VoicePrecision,
): Promise<string> {
  const id = nextRequestId++
  const request: TranscribeRequest = { id, audio, model, precision, wasmBaseUrl: WASM_BASE_URL }
  // Pick the worker before this request counts as pending, so a model switch
  // can replace an idle worker.
  const target = getWorker(voiceEngineKey(model.id, precision))
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    target.postMessage(request, [audio.buffer])
  })
}
