import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'path'
import {
  VOICE_PROTOCOL_SCHEME,
  resolveVoiceProtocolPath,
} from './voice-protocol'

const MODELS_DIR = '/data/pi-desktop/speech-models'

test('the scheme name is stable', () => {
  assert.equal(VOICE_PROTOCOL_SCHEME, 'pi-voice')
})

test('resolves a model file url to a path inside the models dir', () => {
  const path = resolveVoiceProtocolPath(
    'pi-voice://model/moonshine-base/config.json',
    MODELS_DIR,
  )
  assert.equal(path, join(MODELS_DIR, 'moonshine-base', 'config.json'))
})

test('resolves a nested onnx file', () => {
  const path = resolveVoiceProtocolPath(
    'pi-voice://model/whisper-base/onnx/encoder_model_quantized.onnx',
    MODELS_DIR,
  )
  assert.equal(path, join(MODELS_DIR, 'whisper-base', 'onnx', 'encoder_model_quantized.onnx'))
})

test('rejects a path-traversal attempt', () => {
  assert.equal(
    resolveVoiceProtocolPath('pi-voice://model/../../etc/passwd', MODELS_DIR),
    null,
  )
})

test('rejects an unexpected host', () => {
  assert.equal(
    resolveVoiceProtocolPath('pi-voice://evil/moonshine-base/config.json', MODELS_DIR),
    null,
  )
})

test('rejects a url that is not the voice scheme', () => {
  assert.equal(
    resolveVoiceProtocolPath('file:///etc/passwd', MODELS_DIR),
    null,
  )
})
