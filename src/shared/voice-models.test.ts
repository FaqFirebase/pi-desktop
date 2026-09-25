import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  VOICE_MODELS,
  getVoiceModel,
  listVoiceModels,
  voiceModelSizeMb,
  type VoicePrecision,
} from './voice-models'

test('catalog exposes the designed models across both engines', () => {
  const ids = listVoiceModels().map((model) => model.id)
  assert.deepEqual(ids, [
    'moonshine-base',
    'moonshine-tiny',
    'whisper-base',
    'whisper-small',
    'parakeet-v3',
    'parakeet-v2',
  ])
})

test('getVoiceModel returns the entry with its engine and repo', () => {
  const model = getVoiceModel('parakeet-v3')
  assert.equal(model?.engine, 'parakeet')
  assert.equal(model?.repo, 'ysdede/parakeet-tdt-0.6b-v3-onnx')
  assert.equal(model?.languages, 'multi')
})

test('getVoiceModel returns undefined for an unknown id', () => {
  assert.equal(getVoiceModel('does-not-exist'), undefined)
})

test('transformers models use the transformers engine', () => {
  assert.equal(getVoiceModel('moonshine-base')?.engine, 'transformers')
  assert.equal(getVoiceModel('whisper-small')?.engine, 'transformers')
})

test('every model default precision is one it offers', () => {
  for (const model of VOICE_MODELS) {
    assert.ok(
      model.precisions.includes(model.defaultPrecision),
      `${model.id} default precision ${model.defaultPrecision} not in ${model.precisions.join(',')}`,
    )
  }
})

test('every model reports a positive size for each precision it offers', () => {
  for (const model of VOICE_MODELS) {
    for (const precision of model.precisions) {
      assert.ok(
        voiceModelSizeMb(model.id, precision) > 0,
        `${model.id}/${precision} size must be positive`,
      )
    }
  }
})

test('voiceModelSizeMb throws for a precision the model does not offer', () => {
  const missing = 'fp32' as VoicePrecision
  assert.throws(() => voiceModelSizeMb('moonshine-tiny', missing))
})
