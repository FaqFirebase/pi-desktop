import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcContext } from './context'
import type { VoiceSaveServerKeyResult, VoiceStatus } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { MAX_RECORDING_MS, TARGET_SAMPLE_RATE } from '../../shared/voice-audio'
import { configureGuiDataDir } from '../app-data-paths'
import { RENDERER_INDEX_PATH } from '../renderer-origin'
import { makeTempDir } from '../../shared/temp-dir.test-helper'

type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const TRUSTED_EVENT = { senderFrame: { url: process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(RENDERER_INDEX_PATH).href } }
const UNTRUSTED_EVENT = { senderFrame: { url: 'https://example.com/' } }
const SERVER = { baseUrl: 'http://127.0.0.1:8000/v1', model: 'speech-1', language: 'fr', prompt: '' }
const KEY_FILE = 'voice-server-api-key'
const CLIP = new Float32Array(TARGET_SAMPLE_RATE)

// The handler modules bind Electron on import, so the stub goes in first.
const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const electronModule = require.cache[electronPath]!
const originalExports = electronModule.exports

let voiceHandlers: typeof import('./voice-handlers')
let settingsModule: typeof import('./settings')
const workspaceManager = { getActiveWorkspace: () => null } as unknown as IpcContext['workspaceManager']

before(async () => {
  electronModule.exports = {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    shell: {},
    app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  }
  voiceHandlers = await import('./voice-handlers')
  settingsModule = await import('./settings')
  voiceHandlers.registerVoiceHandlers({ workspaceManager, broadcast: () => {} } as unknown as IpcContext)
})

after(() => {
  electronModule.exports = originalExports
})

function freshDataDir(): string {
  const dir = makeTempDir('pi-voice-ipc-')
  configureGuiDataDir(dir)
  return dir
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(handlers.get(channel)!(TRUSTED_EVENT, ...args))
}

test('a clip must be non-empty mono samples no longer than a recording can be', () => {
  const longest = TARGET_SAMPLE_RATE * (MAX_RECORDING_MS + 1000) / 1000
  assert.equal(voiceHandlers.parseVoiceClip(CLIP), CLIP)
  assert.equal(voiceHandlers.parseVoiceClip(new Float32Array(longest)).length, longest)
  for (const bad of [null, [0, 0.5], new Float64Array(4), new Int16Array(4), CLIP.buffer, new Float32Array(0), new Float32Array(longest + 1)]) {
    assert.throws(() => voiceHandlers.parseVoiceClip(bad), Error, String(bad))
  }
})

test('the server channels refuse a sender that is not the app', async () => {
  for (const channel of [IPC_CHANNELS.VOICE_TRANSCRIBE, IPC_CHANNELS.VOICE_SAVE_SERVER_KEY, IPC_CHANNELS.VOICE_CLEAR_SERVER_KEY]) {
    await assert.rejects(Promise.resolve().then(() => handlers.get(channel)!(UNTRUSTED_EVENT, CLIP)), /Unauthorized/, channel)
  }
})

test('transcribe refuses a bad payload before reading settings or sending anything', async () => {
  freshDataDir()
  await assert.rejects(invoke(IPC_CHANNELS.VOICE_TRANSCRIBE, 'audio'), /Float32Array/)
})

test('status reports the transcriber, the server and whether a key is saved, never the key', async () => {
  const dir = freshDataDir()
  let status = await invoke(IPC_CHANNELS.VOICE_STATUS) as VoiceStatus
  assert.equal(status.transcriber, 'local')
  assert.equal(status.serverKeySaved, false)
  await settingsModule.saveAppSettings({ voiceTranscriber: 'server', voiceServer: SERVER })
  assert.deepEqual(await invoke(IPC_CHANNELS.VOICE_SAVE_SERVER_KEY, 'has space'), { ok: false })
  const saved = await invoke(IPC_CHANNELS.VOICE_SAVE_SERVER_KEY, ' sk-test ') as VoiceSaveServerKeyResult
  assert.equal(saved.ok, true)
  status = (saved as { status: VoiceStatus }).status
  assert.equal(status.transcriber, 'server')
  assert.deepEqual(status.server, SERVER)
  assert.equal(status.serverKeySaved, true)
  assert.equal(JSON.stringify(status).includes('sk-test'), false)
  status = await invoke(IPC_CHANNELS.VOICE_CLEAR_SERVER_KEY) as VoiceStatus
  assert.equal(status.serverKeySaved, false)
  // A key another program writes shows up on the next status.
  await writeFile(join(dir, KEY_FILE), 'sk-outside\n')
  assert.equal((await invoke(IPC_CHANNELS.VOICE_STATUS) as VoiceStatus).serverKeySaved, true)
})

test('status still loads when the key file cannot be read, and a request reports it', async () => {
  const dir = freshDataDir()
  await mkdir(join(dir, KEY_FILE))
  const status = await invoke(IPC_CHANNELS.VOICE_STATUS) as VoiceStatus
  assert.equal(status.transcriber, 'local')
  assert.equal(status.serverKeySaved, false)
  await assert.rejects(voiceHandlers.transcribeVoiceClip(workspaceManager, CLIP), /EISDIR|directory/)
})

test('a clip goes to the server and key the files hold at that moment', async () => {
  const dir = freshDataDir()
  const sent: Array<{ url: string; headers: unknown; language: unknown }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers, language: (init.body as FormData).get('language') })
    return new Response(JSON.stringify({ text: `segment ${sent.length}` }))
  }) as typeof fetch
  await assert.rejects(
    voiceHandlers.transcribeVoiceClip(workspaceManager, CLIP, fetchImpl),
    /Settings > Voice dictation/,
  )
  // Written the way another program would: straight into the data folder.
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ voiceTranscriber: 'server', voiceServer: SERVER }))
  assert.equal(await voiceHandlers.transcribeVoiceClip(workspaceManager, CLIP, fetchImpl), 'segment 1')
  await writeFile(join(dir, KEY_FILE), 'sk-outside\n')
  assert.equal(await voiceHandlers.transcribeVoiceClip(workspaceManager, CLIP, fetchImpl), 'segment 2')
  assert.deepEqual(sent, [
    { url: 'http://127.0.0.1:8000/v1/audio/transcriptions', headers: { Accept: 'application/json' }, language: 'fr' },
    {
      url: 'http://127.0.0.1:8000/v1/audio/transcriptions',
      headers: { Accept: 'application/json', Authorization: 'Bearer sk-outside' },
      language: 'fr',
    },
  ])
})

test('segments from both windows reach the server one at a time, in call order', async () => {
  const dir = freshDataDir()
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ voiceTranscriber: 'server', voiceServer: SERVER }))
  const events: string[] = []
  let calls = 0
  const fetchImpl = (async () => {
    const call = ++calls
    events.push(`start ${call}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    events.push(`end ${call}`)
    return new Response(JSON.stringify({ text: String(call) }))
  }) as typeof fetch
  const texts = await Promise.all([1, 2, 3].map(() => voiceHandlers.transcribeVoiceClip(workspaceManager, CLIP, fetchImpl)))
  assert.deepEqual(texts, ['1', '2', '3'])
  assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
})
