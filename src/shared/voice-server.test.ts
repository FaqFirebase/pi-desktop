import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { VoiceStatus } from './ipc-contracts'
import {
  DEFAULT_VOICE_SERVER,
  isVoiceTranscriber,
  normalizeVoiceServerSettings,
  voiceDictationReady,
  voiceServerEndpoint,
  voiceServerReady,
} from './voice-server'
import { listVoiceModels } from './voice-models'

const SERVER = { baseUrl: 'http://127.0.0.1:8000/v1', model: 'speech-1', language: '', prompt: '' }

test('only the two transcribers are known', () => {
  assert.equal(isVoiceTranscriber('local'), true)
  assert.equal(isVoiceTranscriber('server'), true)
  for (const value of ['cloud', '', null, 1]) assert.equal(isVoiceTranscriber(value), false)
})

test('server settings from a file become trimmed strings, whatever the file holds', () => {
  assert.deepEqual(normalizeVoiceServerSettings(undefined), DEFAULT_VOICE_SERVER)
  assert.deepEqual(normalizeVoiceServerSettings(['x']), DEFAULT_VOICE_SERVER)
  assert.deepEqual(
    normalizeVoiceServerSettings({ baseUrl: ' https://s.example/v1 ', model: 42, language: ' fr ', prompt: ' Pi, OMP ', extra: 1 }),
    { baseUrl: 'https://s.example/v1', model: '', language: 'fr', prompt: 'Pi, OMP' },
  )
})

test('the endpoint is the base address plus audio/transcriptions, with or without a trailing slash', () => {
  assert.equal(voiceServerEndpoint('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/audio/transcriptions')
  assert.equal(voiceServerEndpoint('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1/audio/transcriptions')
  assert.equal(voiceServerEndpoint('https://s.example'), 'https://s.example/audio/transcriptions')
  assert.equal(voiceServerEndpoint('https://[::1]:9000/api/v1//'), 'https://[::1]:9000/api/v1/audio/transcriptions')
})

test('an address that is not plain http or https is refused', () => {
  for (const baseUrl of ['', 's.example/v1', 'ftp://s.example', 'file:///tmp/v1', 'https://user:pw@s.example/v1',
    'https://s.example/v1?key=1', 'https://s.example/v1#x']) {
    assert.equal(voiceServerEndpoint(baseUrl), null, baseUrl)
  }
})

test('a server is ready with a valid address and a model', () => {
  assert.equal(voiceServerReady(SERVER), true)
  assert.equal(voiceServerReady({ ...SERVER, model: '' }), false)
  assert.equal(voiceServerReady({ ...SERVER, baseUrl: 'not a url' }), false)
  assert.equal(voiceServerReady(DEFAULT_VOICE_SERVER), false)
})

test('dictation is ready with an installed local model, or a ready server when the server is chosen', () => {
  const catalog = [...listVoiceModels()]
  const model = catalog[0]
  const status: VoiceStatus = {
    catalog, installed: [], selectedModel: model.id, selectedPrecision: 'int8', device: 'auto', restartRequired: false,
    transcriber: 'local', server: DEFAULT_VOICE_SERVER, serverKeySaved: false,
  }
  const installed = [{ id: model.id, precision: 'int8' as const, repo: model.repo, files: [], installedAt: '2026-01-01T00:00:00Z' }]
  assert.equal(voiceDictationReady(status), false)
  assert.equal(voiceDictationReady({ ...status, installed }), true)
  assert.equal(voiceDictationReady({ ...status, installed, selectedModel: null }), false)
  assert.equal(voiceDictationReady({ ...status, installed, transcriber: 'server' }), false)
  assert.equal(voiceDictationReady({ ...status, transcriber: 'server', server: SERVER }), true)
})
