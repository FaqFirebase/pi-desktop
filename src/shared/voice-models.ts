// Catalog of on-device speech-to-text models the voice dictation feature can
// install. Every model runs in a pure-JavaScript engine (no native build):
// `transformers` uses transformers.js (Moonshine, Whisper); `parakeet` uses
// parakeet.js on onnxruntime-web (NVIDIA Parakeet). Nothing here is downloaded
// automatically — the user picks a model, then the main process fetches it.

export type VoiceEngine = 'transformers' | 'parakeet'

export type VoiceLanguages = 'en' | 'multi'

export type VoicePrecision = 'int8' | 'fp16'

export interface VoiceModel {
  /** Stable identifier used for storage folders, settings, and IPC. */
  id: string
  /** Engine that loads and runs this model. */
  engine: VoiceEngine
  /** Hugging Face repository the ONNX weights come from. */
  repo: string
  /** `en` = English only; `multi` = many languages with auto-detection. */
  languages: VoiceLanguages
  /** SPDX license identifier of the model weights, shown for attribution. */
  license: string
  /** Precision selected when none is chosen explicitly. */
  defaultPrecision: VoicePrecision
  /** Precisions the user may install for this model. */
  precisions: VoicePrecision[]
  /** Approximate on-disk download size in megabytes, per precision. */
  approxSizeMb: Record<VoicePrecision, number>
  /** i18n key for the one-line description shown in the picker. */
  noteKey: string
}

export const VOICE_MODELS: readonly VoiceModel[] = [
  {
    id: 'moonshine-base',
    engine: 'transformers',
    repo: 'onnx-community/moonshine-base-ONNX',
    languages: 'en',
    license: 'MIT',
    defaultPrecision: 'int8',
    precisions: ['int8', 'fp16'],
    approxSizeMb: { int8: 63, fp16: 201 },
    noteKey: 'voice.models.moonshine-base.note',
  },
  {
    id: 'moonshine-tiny',
    engine: 'transformers',
    repo: 'onnx-community/moonshine-tiny-ONNX',
    languages: 'en',
    license: 'MIT',
    defaultPrecision: 'int8',
    precisions: ['int8', 'fp16'],
    approxSizeMb: { int8: 28, fp16: 92 },
    noteKey: 'voice.models.moonshine-tiny.note',
  },
  {
    id: 'whisper-base',
    engine: 'transformers',
    repo: 'Xenova/whisper-base',
    languages: 'multi',
    license: 'Apache-2.0',
    defaultPrecision: 'int8',
    precisions: ['int8', 'fp16'],
    approxSizeMb: { int8: 77, fp16: 146 },
    noteKey: 'voice.models.whisper-base.note',
  },
  {
    id: 'whisper-small',
    engine: 'transformers',
    repo: 'Xenova/whisper-small',
    languages: 'multi',
    license: 'Apache-2.0',
    defaultPrecision: 'int8',
    precisions: ['int8', 'fp16'],
    approxSizeMb: { int8: 249, fp16: 485 },
    noteKey: 'voice.models.whisper-small.note',
  },
  {
    id: 'parakeet-v3',
    engine: 'parakeet',
    repo: 'ysdede/parakeet-tdt-0.6b-v3-onnx',
    languages: 'multi',
    license: 'CC-BY-4.0',
    defaultPrecision: 'int8',
    precisions: ['int8', 'fp16'],
    approxSizeMb: { int8: 670, fp16: 1275 },
    noteKey: 'voice.models.parakeet-v3.note',
  },
  {
    id: 'parakeet-v2',
    engine: 'parakeet',
    repo: 'ysdede/parakeet-tdt-0.6b-v2-onnx',
    languages: 'en',
    license: 'CC-BY-4.0',
    defaultPrecision: 'int8',
    precisions: ['int8', 'fp16'],
    approxSizeMb: { int8: 661, fp16: 1257 },
    noteKey: 'voice.models.parakeet-v2.note',
  },
]

/** Live progress of a model download, streamed main -> renderer. */
export interface VoiceDownloadProgress {
  /** Files finished so far. */
  completedFiles: number
  /** Total files to download. */
  totalFiles: number
  /** Bytes downloaded across all files so far. */
  receivedBytes: number
  /** Total bytes to download when known, else null. */
  totalBytes: number | null
  /** File currently downloading. */
  currentFile: string
}

/** Record written to a model folder once its files finish downloading. */
export interface VoiceModelManifest {
  /** Model id, matching a catalog entry. */
  id: string
  /** Precision that was installed. */
  precision: VoicePrecision
  /** Repository the files came from. */
  repo: string
  /** Relative paths of the downloaded files, from the model folder root. */
  files: string[]
  /** ISO timestamp of when the install completed. */
  installedAt: string
}

export function listVoiceModels(): readonly VoiceModel[] {
  return VOICE_MODELS
}

export function getVoiceModel(id: string): VoiceModel | undefined {
  return VOICE_MODELS.find((model) => model.id === id)
}

export function voiceModelSizeMb(id: string, precision: VoicePrecision): number {
  const model = getVoiceModel(id)
  if (!model) {
    throw new Error(`Unknown voice model: ${id}`)
  }
  if (!model.precisions.includes(precision)) {
    throw new Error(`Voice model ${id} does not offer precision ${precision}`)
  }
  return model.approxSizeMb[precision]
}
