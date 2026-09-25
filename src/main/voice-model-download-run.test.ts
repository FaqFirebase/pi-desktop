import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getVoiceModel, type VoiceDownloadProgress } from '../shared/voice-models'
import { downloadVoiceModel } from './voice-model-download'
import {
  isVoiceModelInstalled,
  readVoiceModelManifest,
  voiceModelDir,
} from './voice-model-store'

const MODEL = getVoiceModel('moonshine-base')!

const REPO_FILES = [
  'config.json',
  'tokenizer.json',
  'README.md',
  'onnx/encoder_model_quantized.onnx',
  'onnx/encoder_model_fp16.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
  'onnx/decoder_model_merged_fp16.onnx',
]

function fakeFetch(bodies: Record<string, string>) {
  return async (url: string): Promise<Response> => {
    for (const [file, content] of Object.entries(bodies)) {
      if (url.includes(`/resolve/main/${file}`)) {
        return new Response(content, { status: 200 })
      }
    }
    return new Response('missing', { status: 404 })
  }
}

const BODIES: Record<string, string> = {
  'config.json': '{"a":1}',
  'tokenizer.json': '{"t":2}',
  'onnx/encoder_model_quantized.onnx': 'ENCODER_BYTES',
  'onnx/decoder_model_merged_quantized.onnx': 'DECODER',
}

async function tempOpts() {
  return { userDataDir: await mkdtemp(join(tmpdir(), 'pi-voice-dl-')) }
}

test('downloads the int8 files to disk and marks the model installed', async () => {
  const opts = await tempOpts()
  await downloadVoiceModel(MODEL, 'int8', {
    ...opts,
    fetchImpl: fakeFetch(BODIES),
    listRepoFiles: async () => REPO_FILES,
  })

  assert.equal(await isVoiceModelInstalled('moonshine-base', opts), true)
  const dir = voiceModelDir('moonshine-base', opts)
  assert.equal(
    await readFile(join(dir, 'onnx/encoder_model_quantized.onnx'), 'utf8'),
    'ENCODER_BYTES',
  )
  assert.equal(await readFile(join(dir, 'config.json'), 'utf8'), '{"a":1}')
})

test('the manifest records the precision and the exact files fetched', async () => {
  const opts = await tempOpts()
  await downloadVoiceModel(MODEL, 'int8', {
    ...opts,
    fetchImpl: fakeFetch(BODIES),
    listRepoFiles: async () => REPO_FILES,
  })
  const manifest = await readVoiceModelManifest('moonshine-base', opts)
  assert.equal(manifest?.precision, 'int8')
  assert.deepEqual(manifest?.files.sort(), [
    'config.json',
    'onnx/decoder_model_merged_quantized.onnx',
    'onnx/encoder_model_quantized.onnx',
    'tokenizer.json',
  ])
})

test('progress ends with every file complete and all bytes counted', async () => {
  const opts = await tempOpts()
  const seen: VoiceDownloadProgress[] = []
  await downloadVoiceModel(MODEL, 'int8', {
    ...opts,
    fetchImpl: fakeFetch(BODIES),
    listRepoFiles: async () => REPO_FILES,
    onProgress: (p) => seen.push(p),
  })
  const last = seen[seen.length - 1]
  assert.equal(last.completedFiles, last.totalFiles)
  assert.equal(last.totalFiles, 4)
  const expectedBytes = ['{"a":1}', '{"t":2}', 'ENCODER_BYTES', 'DECODER']
    .reduce((sum, s) => sum + Buffer.byteLength(s), 0)
  assert.equal(last.receivedBytes, expectedBytes)
})

test('re-installing at a different precision leaves no leftover file', async () => {
  const opts = await tempOpts()
  await downloadVoiceModel(MODEL, 'int8', {
    ...opts,
    fetchImpl: fakeFetch(BODIES),
    listRepoFiles: async () => REPO_FILES,
  })
  await downloadVoiceModel(MODEL, 'fp16', {
    ...opts,
    fetchImpl: fakeFetch({
      'config.json': '{"a":1}',
      'tokenizer.json': '{"t":2}',
      'onnx/encoder_model_fp16.onnx': 'ENC16',
      'onnx/decoder_model_merged_fp16.onnx': 'DEC16',
    }),
    listRepoFiles: async () => REPO_FILES,
  })
  const dir = voiceModelDir('moonshine-base', opts)
  assert.equal(existsSync(join(dir, 'onnx/encoder_model_quantized.onnx')), false)
  assert.equal(existsSync(join(dir, 'onnx/encoder_model_fp16.onnx')), true)
  assert.equal((await readVoiceModelManifest('moonshine-base', opts))?.precision, 'fp16')
})

test('a failed file download throws and does not mark the model installed', async () => {
  const opts = await tempOpts()
  await assert.rejects(
    downloadVoiceModel(MODEL, 'int8', {
      ...opts,
      fetchImpl: fakeFetch({ 'config.json': '{}' }), // others 404
      listRepoFiles: async () => REPO_FILES,
    }),
  )
  assert.equal(await isVoiceModelInstalled('moonshine-base', opts), false)
})

test('an aborted signal stops the download', async () => {
  const opts = await tempOpts()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    downloadVoiceModel(MODEL, 'int8', {
      ...opts,
      fetchImpl: fakeFetch(BODIES),
      listRepoFiles: async () => REPO_FILES,
      signal: controller.signal,
    }),
  )
  assert.equal(await isVoiceModelInstalled('moonshine-base', opts), false)
})
