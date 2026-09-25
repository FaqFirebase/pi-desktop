import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeStoredSettings } from './app-settings'
import { DEFAULT_SETTINGS } from './default-settings'

const LANGUAGES = ['en']

test('normalizeStoredSettings keeps known values', () => {
  const settings = normalizeStoredSettings({ permissionMode: 'trusted', piEngine: 'omp', language: 'en' }, LANGUAGES)
  assert.equal(settings.permissionMode, 'trusted')
  assert.equal(settings.piEngine, 'omp')
  assert.equal(settings.language, 'en')
})

test('normalizeStoredSettings falls back to defaults for unknown values', () => {
  const settings = normalizeStoredSettings({ permissionMode: 'yolo', piEngine: 'codex', language: 'xx' }, LANGUAGES)
  assert.equal(settings.permissionMode, DEFAULT_SETTINGS.permissionMode)
  assert.equal(settings.piEngine, 'auto')
  assert.equal(settings.language, DEFAULT_SETTINGS.language)
})

test('normalizeStoredSettings fills missing keys from the defaults', () => {
  const settings = normalizeStoredSettings({}, LANGUAGES)
  assert.deepEqual(settings, DEFAULT_SETTINGS)
})

test('chat width defaults to normal and keeps a known value', () => {
  assert.equal(DEFAULT_SETTINGS.chatWidth, 'normal')
  assert.equal(normalizeStoredSettings({ chatWidth: 'full' }, LANGUAGES).chatWidth, 'full')
})

test('normalizeStoredSettings resets an invalid chat width', () => {
  const settings = normalizeStoredSettings({ chatWidth: 'huge' }, LANGUAGES)
  assert.equal(settings.chatWidth, DEFAULT_SETTINGS.chatWidth)
})

test('voice model defaults to none so nothing downloads automatically', () => {
  assert.equal(DEFAULT_SETTINGS.voiceModel, null)
  assert.equal(DEFAULT_SETTINGS.voicePrecision, 'int8')
})

test('normalizeStoredSettings keeps a known voice model and precision', () => {
  const settings = normalizeStoredSettings(
    { voiceModel: 'parakeet-v3', voicePrecision: 'fp16' },
    LANGUAGES,
  )
  assert.equal(settings.voiceModel, 'parakeet-v3')
  assert.equal(settings.voicePrecision, 'fp16')
})

test('normalizeStoredSettings resets an unknown voice model to none', () => {
  const settings = normalizeStoredSettings({ voiceModel: 'ghost-model' }, LANGUAGES)
  assert.equal(settings.voiceModel, null)
})

test('normalizeStoredSettings resets an invalid voice precision', () => {
  const settings = normalizeStoredSettings({ voicePrecision: 'fp64' }, LANGUAGES)
  assert.equal(settings.voicePrecision, DEFAULT_SETTINGS.voicePrecision)
})

test('voice device defaults to auto and keeps a known value', () => {
  assert.equal(DEFAULT_SETTINGS.voiceDevice, 'auto')
  assert.equal(normalizeStoredSettings({ voiceDevice: 'gpu' }, LANGUAGES).voiceDevice, 'gpu')
})

test('normalizeStoredSettings resets an invalid voice device', () => {
  const settings = normalizeStoredSettings({ voiceDevice: 'npu' }, LANGUAGES)
  assert.equal(settings.voiceDevice, DEFAULT_SETTINGS.voiceDevice)
})
