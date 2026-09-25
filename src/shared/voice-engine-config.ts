import type { VoicePrecision } from './voice-models'

// Base URL the renderer engines load model files from. It resolves to the
// main-process `pi-voice` protocol handler, which streams files from the single
// speech-models directory. Kept in shared so the renderer and its tests agree.
export const VOICE_MODEL_BASE_URL = 'pi-voice://model/'

// transformers.js resolves an onnx file by a dtype suffix. Downloads use the
// `_quantized` build for int8 (dtype 'q8') and `_fp16` for fp16.
const TRANSFORMERS_DTYPE: Record<VoicePrecision, string> = {
  int8: 'q8',
  fp16: 'fp16',
}

export function transformersDtype(precision: VoicePrecision): string {
  return TRANSFORMERS_DTYPE[precision]
}

export function transformersModelPath(modelId: string): string {
  return `${VOICE_MODEL_BASE_URL}${modelId}`
}

export interface ParakeetFileUrls {
  encoderUrl: string
  decoderUrl: string
  tokenizerUrl: string
  preprocessorUrl: string
}

export function parakeetFileUrls(modelId: string, precision: VoicePrecision): ParakeetFileUrls {
  const base = `${VOICE_MODEL_BASE_URL}${modelId}`
  return {
    encoderUrl: `${base}/encoder-model.${precision}.onnx`,
    decoderUrl: `${base}/decoder_joint-model.${precision}.onnx`,
    tokenizerUrl: `${base}/vocab.txt`,
    preprocessorUrl: `${base}/nemo128.onnx`,
  }
}
