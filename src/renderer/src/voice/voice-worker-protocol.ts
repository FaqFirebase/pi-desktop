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

/** Worker to page: the transcript, or why it failed. */
export type TranscribeResponse = { id: number; text: string } | { id: number; error: string }
