import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectVoiceModelFiles } from './voice-model-download'

// Real, trimmed file listings from each repo.
const MOONSHINE_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'README.md',
  'onnx/encoder_model.onnx',
  'onnx/encoder_model_fp16.onnx',
  'onnx/encoder_model_int8.onnx',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged.onnx',
  'onnx/decoder_model_merged_fp16.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
  'onnx/decoder_with_past_model_quantized.onnx',
]

const WHISPER_FILES = [
  'config.json',
  'merges.txt',
  'vocab.json',
  'tokenizer.json',
  'onnx/encoder_model_fp16.onnx',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_fp16.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
  'onnx/decoder_with_past_model_quantized.onnx',
]

const PARAKEET_FILES = [
  'config.json',
  'vocab.txt',
  'nemo128.onnx',
  'encoder-model.fp16.onnx',
  'encoder-model.int8.onnx',
  'encoder-model.onnx',
  'encoder-model.onnx.data',
  'decoder_joint-model.fp16.onnx',
  'decoder_joint-model.int8.onnx',
  'decoder_joint-model.onnx',
  'provenance/manifest.json',
]

test('transformers int8 keeps configs plus only the quantized encoder and merged decoder', () => {
  const files = selectVoiceModelFiles('transformers', 'int8', MOONSHINE_FILES)
  assert.deepEqual(files.sort(), [
    'config.json',
    'generation_config.json',
    'onnx/decoder_model_merged_quantized.onnx',
    'onnx/encoder_model_quantized.onnx',
    'preprocessor_config.json',
    'special_tokens_map.json',
    'tokenizer.json',
    'tokenizer_config.json',
  ])
})

test('transformers fp16 selects the fp16 onnx pair and drops other precisions', () => {
  const files = selectVoiceModelFiles('transformers', 'fp16', MOONSHINE_FILES)
  assert.ok(files.includes('onnx/encoder_model_fp16.onnx'))
  assert.ok(files.includes('onnx/decoder_model_merged_fp16.onnx'))
  assert.ok(!files.some((f) => f.includes('quantized')))
  assert.ok(!files.some((f) => f.includes('_int8')))
  assert.ok(!files.some((f) => f.includes('decoder_with_past')))
})

test('transformers keeps top-level text tokenizer files like merges.txt and vocab.json', () => {
  const files = selectVoiceModelFiles('transformers', 'int8', WHISPER_FILES)
  assert.ok(files.includes('merges.txt'))
  assert.ok(files.includes('vocab.json'))
})

test('transformers never includes README or the base unquantized onnx', () => {
  const files = selectVoiceModelFiles('transformers', 'int8', MOONSHINE_FILES)
  assert.ok(!files.includes('README.md'))
  assert.ok(!files.includes('onnx/encoder_model.onnx'))
  assert.ok(!files.includes('onnx/decoder_model_merged.onnx'))
})

test('parakeet int8 keeps the int8 encoder, joint decoder, vocab, config, and features', () => {
  const files = selectVoiceModelFiles('parakeet', 'int8', PARAKEET_FILES)
  assert.deepEqual(files.sort(), [
    'config.json',
    'decoder_joint-model.int8.onnx',
    'encoder-model.int8.onnx',
    'nemo128.onnx',
    'vocab.txt',
  ])
})

test('parakeet fp16 selects fp16 weights and never the external-data base model', () => {
  const files = selectVoiceModelFiles('parakeet', 'fp16', PARAKEET_FILES)
  assert.ok(files.includes('encoder-model.fp16.onnx'))
  assert.ok(files.includes('decoder_joint-model.fp16.onnx'))
  assert.ok(!files.includes('encoder-model.onnx'))
  assert.ok(!files.includes('encoder-model.onnx.data'))
  assert.ok(!files.some((f) => f.startsWith('provenance/')))
})
