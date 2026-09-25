import type { VoiceModel, VoicePrecision } from '../../../shared/voice-models'

/** Page to worker: transcribe one clip of mono 16 kHz PCM. */
export interface TranscribeRequest {
  id: number
  audio: Float32Array
  model: VoiceModel
  precision: VoicePrecision
  /** Where onnxruntime-web loads its WebAssembly runtime from. */
  wasmBaseUrl: string
}

/**
 * Error message the worker sends when an fp16 (GPU) model has no hardware GPU
 * to run on. The page shows its own translated text for it.
 */
export const VOICE_NEEDS_GPU_ERROR = 'voice-needs-gpu'

/** Identifies one loaded engine: a model at a precision. */
export function voiceEngineKey(modelId: string, precision: VoicePrecision): string {
  return `${modelId}:${precision}`
}

/** Worker to page: the transcript, or why it failed. */
export type TranscribeResponse = { id: number; text: string } | { id: number; error: string }
