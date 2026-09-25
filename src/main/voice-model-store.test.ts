import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { VoiceModelManifest } from '../shared/voice-models'
import {
  getVoiceModelsDir,
  voiceModelDir,
  writeVoiceModelManifest,
  readVoiceModelManifest,
  isVoiceModelInstalled,
  listInstalledVoiceModels,
  removeVoiceModel,
} from './voice-model-store'

async function tempStore(): Promise<{ userDataDir: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'pi-voice-store-'))
  return { userDataDir }
}

const SAMPLE: VoiceModelManifest = {
  id: 'moonshine-base',
  precision: 'int8',
  repo: 'onnx-community/moonshine-base-ONNX',
  files: ['config.json', 'onnx/encoder_model_quantized.onnx'],
  installedAt: '2026-09-16T00:00:00.000Z',
}

test('getVoiceModelsDir nests speech-models under the gui data dir', async () => {
  const opts = await tempStore()
  assert.equal(getVoiceModelsDir(opts), join(opts.userDataDir, 'speech-models'))
})

test('voiceModelDir gives each model its own folder', async () => {
  const opts = await tempStore()
  assert.equal(
    voiceModelDir('parakeet-v3', opts),
    join(opts.userDataDir, 'speech-models', 'parakeet-v3'),
  )
})

test('a model is not installed until its manifest is written', async () => {
  const opts = await tempStore()
  assert.equal(await isVoiceModelInstalled('moonshine-base', opts), false)
  await writeVoiceModelManifest(SAMPLE, opts)
  assert.equal(await isVoiceModelInstalled('moonshine-base', opts), true)
})

test('the written manifest reads back unchanged', async () => {
  const opts = await tempStore()
  await writeVoiceModelManifest(SAMPLE, opts)
  assert.deepEqual(await readVoiceModelManifest('moonshine-base', opts), SAMPLE)
})

test('readVoiceModelManifest returns null when nothing is installed', async () => {
  const opts = await tempStore()
  assert.equal(await readVoiceModelManifest('whisper-base', opts), null)
})

test('listInstalledVoiceModels returns every written manifest', async () => {
  const opts = await tempStore()
  await writeVoiceModelManifest(SAMPLE, opts)
  await writeVoiceModelManifest({ ...SAMPLE, id: 'whisper-base', repo: 'Xenova/whisper-base' }, opts)
  const ids = (await listInstalledVoiceModels(opts)).map((m) => m.id).sort()
  assert.deepEqual(ids, ['moonshine-base', 'whisper-base'])
})

test('listInstalledVoiceModels ignores folders without a valid manifest', async () => {
  const opts = await tempStore()
  await writeVoiceModelManifest(SAMPLE, opts)
  const strayDir = join(getVoiceModelsDir(opts), 'half-downloaded')
  await mkdir(strayDir, { recursive: true })
  await writeFile(join(strayDir, 'partial.bin'), 'x')
  const ids = (await listInstalledVoiceModels(opts)).map((m) => m.id)
  assert.deepEqual(ids, ['moonshine-base'])
})

test('removeVoiceModel deletes the whole model folder', async () => {
  const opts = await tempStore()
  await writeVoiceModelManifest(SAMPLE, opts)
  assert.equal(await isVoiceModelInstalled('moonshine-base', opts), true)
  await removeVoiceModel('moonshine-base', opts)
  assert.equal(await isVoiceModelInstalled('moonshine-base', opts), false)
  assert.equal(existsSync(voiceModelDir('moonshine-base', opts)), false)
})

test('removeVoiceModel of a missing model does not throw', async () => {
  const opts = await tempStore()
  await removeVoiceModel('parakeet-v2', opts)
})
