import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  VOICE_MODEL_BASE_URL,
  transformersDtype,
  parakeetFileUrls,
  transformersModelPath,
} from './voice-engine-config'

test('the model base url uses the pi-voice protocol', () => {
  assert.equal(VOICE_MODEL_BASE_URL, 'pi-voice://model/')
})

test('int8 maps to the q8 dtype that resolves the _quantized onnx files', () => {
  assert.equal(transformersDtype('int8'), 'q8')
})

test('fp16 maps to the fp16 dtype', () => {
  assert.equal(transformersDtype('fp16'), 'fp16')
})

test('the transformers model path is the base url plus the model id', () => {
  assert.equal(transformersModelPath('whisper-base'), 'pi-voice://model/whisper-base')
})

test('parakeet int8 urls point at the int8 weights, vocab, and features', () => {
  const urls = parakeetFileUrls('parakeet-v3', 'int8')
  assert.deepEqual(urls, {
    encoderUrl: 'pi-voice://model/parakeet-v3/encoder-model.int8.onnx',
    decoderUrl: 'pi-voice://model/parakeet-v3/decoder_joint-model.int8.onnx',
    tokenizerUrl: 'pi-voice://model/parakeet-v3/vocab.txt',
    preprocessorUrl: 'pi-voice://model/parakeet-v3/nemo128.onnx',
  })
})

test('parakeet fp16 urls point at the fp16 weights', () => {
  const urls = parakeetFileUrls('parakeet-v2', 'fp16')
  assert.equal(urls.encoderUrl, 'pi-voice://model/parakeet-v2/encoder-model.fp16.onnx')
  assert.equal(urls.decoderUrl, 'pi-voice://model/parakeet-v2/decoder_joint-model.fp16.onnx')
})
