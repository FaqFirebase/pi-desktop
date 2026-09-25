import { mkdir, writeFile, rename, rm } from 'fs/promises'
import { dirname, join } from 'path'
import type {
  VoiceEngine,
  VoicePrecision,
  VoiceModel,
  VoiceDownloadProgress,
} from '../shared/voice-models'
import { voiceModelDir, writeVoiceModelManifest } from './voice-model-store'

const HF_HOST = 'https://huggingface.co'

// transformers.js resolves an onnx file by a dtype suffix. int8 maps to the
// `_quantized` build because every Whisper encoder ships that variant while some
// omit a plain `_int8` encoder. fp16 maps to `_fp16`.
const TRANSFORMERS_SUFFIX: Record<VoicePrecision, string> = {
  int8: '_quantized',
  fp16: '_fp16',
}

const TRANSFORMERS_TEXT_EXTENSIONS = ['.json', '.txt']

/**
 * Choose exactly the repository files needed to run one model at one precision.
 * Pure: it filters a listing, it does not touch the network or disk.
 */
export function selectVoiceModelFiles(
  engine: VoiceEngine,
  precision: VoicePrecision,
  repoFiles: string[],
): string[] {
  if (engine === 'parakeet') {
    const wanted = new Set([
      'config.json',
      'vocab.txt',
      'nemo128.onnx',
      `encoder-model.${precision}.onnx`,
      `decoder_joint-model.${precision}.onnx`,
    ])
    return repoFiles.filter((file) => wanted.has(file))
  }

  const suffix = TRANSFORMERS_SUFFIX[precision]
  const onnxFiles = new Set([
    `onnx/encoder_model${suffix}.onnx`,
    `onnx/decoder_model_merged${suffix}.onnx`,
  ])
  return repoFiles.filter((file) => {
    if (file.startsWith('onnx/')) {
      return onnxFiles.has(file)
    }
    if (file.includes('/')) {
      return false
    }
    return TRANSFORMERS_TEXT_EXTENSIONS.some((ext) => file.endsWith(ext))
  })
}

type FetchLike = (url: string) => Promise<Response>

export interface DownloadVoiceModelDeps {
  fetchImpl?: FetchLike
  listRepoFiles?: (repo: string) => Promise<string[]>
  onProgress?: (progress: VoiceDownloadProgress) => void
  signal?: AbortSignal
  homeDir?: string
  appDataDir?: string
  userDataDir?: string
}

async function listRepoFilesFromHub(repo: string, fetchImpl: FetchLike): Promise<string[]> {
  const response = await fetchImpl(`${HF_HOST}/api/models/${repo}/tree/main?recursive=true`)
  if (!response.ok) {
    throw new Error(`Failed to list ${repo}: HTTP ${response.status}`)
  }
  const entries = (await response.json()) as Array<{ path: string; type?: string }>
  return entries.filter((entry) => entry.type !== 'directory').map((entry) => entry.path)
}

function fileUrl(repo: string, file: string): string {
  return `${HF_HOST}/${repo}/resolve/main/${file}?download=true`
}

/**
 * Download one model at one precision into its own folder, reporting progress,
 * then write the manifest that marks it installed. Files land in the single
 * `speech-models/<id>` folder so nothing hides in an opaque cache.
 */
export async function downloadVoiceModel(
  model: VoiceModel,
  precision: VoicePrecision,
  deps: DownloadVoiceModelDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike)
  const listFiles = deps.listRepoFiles ?? ((repo: string) => listRepoFilesFromHub(repo, fetchImpl))

  const repoFiles = await listFiles(model.repo)
  const files = selectVoiceModelFiles(model.engine, precision, repoFiles)
  if (files.length === 0) {
    throw new Error(`No files matched ${model.id} at precision ${precision}`)
  }

  const destDir = voiceModelDir(model.id, deps)
  // Start from a clean folder so a re-install never mixes precisions.
  await rm(destDir, { recursive: true, force: true })
  await mkdir(destDir, { recursive: true })

  let receivedBytes = 0
  let completedFiles = 0
  const report = (currentFile: string) => {
    deps.onProgress?.({
      completedFiles,
      totalFiles: files.length,
      receivedBytes,
      totalBytes: null,
      currentFile,
    })
  }

  for (const file of files) {
    deps.signal?.throwIfAborted()
    report(file)
    const response = await fetchImpl(fileUrl(model.repo, file))
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${file}: HTTP ${response.status}`)
    }
    const targetPath = join(destDir, file)
    await mkdir(dirname(targetPath), { recursive: true })
    const tempPath = `${targetPath}.part`
    const chunks: Uint8Array[] = []
    for await (const chunk of streamOf(response.body)) {
      deps.signal?.throwIfAborted()
      chunks.push(chunk)
      receivedBytes += chunk.byteLength
    }
    await writeFile(tempPath, Buffer.concat(chunks))
    await rename(tempPath, targetPath)
    completedFiles += 1
    report(file)
  }

  await writeVoiceModelManifest(
    {
      id: model.id,
      precision,
      repo: model.repo,
      files,
      installedAt: new Date().toISOString(),
    },
    deps,
  )
}

async function* streamOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}
