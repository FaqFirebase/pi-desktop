import assert from 'node:assert/strict'
import { test } from 'node:test'
import { t } from '../shared/i18n'
import { DEFAULT_VOICE_SERVER, type VoiceServerSettings } from '../shared/voice-server'
import { transcribeWithServer, transcriptionForm, VOICE_SERVER_TIMEOUT_MS } from './voice-server-transcription'

const SERVER: VoiceServerSettings = { baseUrl: 'http://127.0.0.1:8000/v1/', model: 'speech-1', language: '', prompt: '' }
const ENDPOINT = 'http://127.0.0.1:8000/v1/audio/transcriptions'
const AUDIO = Float32Array.from([0, 0.5, -0.5, 0])
const WAV_HEADER_BYTES = 44

interface SentRequest {
  url: string
  init: RequestInit
}

/** A fetch that records each request and answers with `respond`. */
function fakeFetch(respond: () => Response | Promise<Response>): { fetch: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    return respond()
  }) as typeof fetch
  return { fetch: fetchImpl, sent }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('the form carries the WAV file, the model and JSON format, and leaves out empty language and prompt', async () => {
  const form = transcriptionForm(SERVER, AUDIO)
  assert.deepEqual([...form.keys()], ['file', 'model', 'response_format'])
  assert.equal(form.get('model'), 'speech-1')
  assert.equal(form.get('response_format'), 'json')
  const file = form.get('file') as File
  assert.equal(file.name, 'speech.wav')
  assert.equal(file.type, 'audio/wav')
  const bytes = new Uint8Array(await file.arrayBuffer())
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF')
  assert.equal(bytes.byteLength, WAV_HEADER_BYTES + AUDIO.length * 2)
})

test('a language and a prompt are sent when the user set them', () => {
  const form = transcriptionForm({ ...SERVER, language: 'fr', prompt: 'Pi Desktop, OMP' }, AUDIO)
  assert.deepEqual([...form.keys()], ['file', 'model', 'language', 'prompt', 'response_format'])
  assert.equal(form.get('language'), 'fr')
  assert.equal(form.get('prompt'), 'Pi Desktop, OMP')
})

test('one POST to the endpoint returns the trimmed text, with no Authorization header when there is no key', async () => {
  const server = fakeFetch(() => json({ text: ' Hello there. ' }))
  assert.equal(await transcribeWithServer({ server: SERVER, apiKey: null, audio: AUDIO }, server.fetch), 'Hello there.')
  assert.equal(server.sent.length, 1)
  const [{ url, init }] = server.sent
  assert.equal(url, ENDPOINT)
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.headers, { Accept: 'application/json' })
  assert.ok(init.body instanceof FormData)
  assert.ok(init.signal instanceof AbortSignal)
})

test('a saved key is sent as a Bearer token', async () => {
  const server = fakeFetch(() => json({ text: 'ok' }))
  await transcribeWithServer({ server: SERVER, apiKey: 'sk-local', audio: AUDIO }, server.fetch)
  assert.deepEqual(server.sent[0].init.headers, { Accept: 'application/json', Authorization: 'Bearer sk-local' })
})

test('without an address or a model nothing is sent', async () => {
  for (const server of [DEFAULT_VOICE_SERVER, { ...SERVER, model: '' }, { ...SERVER, baseUrl: 'ftp://host/v1' }]) {
    const fetch = fakeFetch(() => json({ text: 'never' }))
    await assert.rejects(
      transcribeWithServer({ server, apiKey: null, audio: AUDIO }, fetch.fetch),
      { message: t('errors.voice.serverNotConfigured') },
    )
    assert.equal(fetch.sent.length, 0)
  }
})

test('an error status shows the server reason: an OpenAI error message, else the body, else the status text', async () => {
  const cases: Array<[Response, string]> = [
    [json({ error: { message: 'Invalid API key', type: 'auth' } }, 401), 'Invalid API key'],
    [json({ error: 'model not found' }, 404), 'model not found'],
    [new Response('<html>\n  Bad   gateway\n</html>', { status: 502 }), '<html> Bad gateway </html>'],
    [new Response('', { status: 503, statusText: 'Service Unavailable' }), 'Service Unavailable'],
    [new Response('x'.repeat(1000), { status: 500 }), 'x'.repeat(200)],
  ]
  for (const [response, detail] of cases) {
    await assert.rejects(
      transcribeWithServer({ server: SERVER, apiKey: null, audio: AUDIO }, fakeFetch(() => response).fetch),
      { message: t('errors.voice.serverStatus', { status: response.status, detail }) },
    )
  }
})

test('an answer without text is an error, not an empty transcript', async () => {
  for (const response of [json({ transcript: 'hi' }), json(null), new Response('hi')]) {
    await assert.rejects(
      transcribeWithServer({ server: SERVER, apiKey: null, audio: AUDIO }, fakeFetch(() => response).fetch),
      { message: t('errors.voice.serverBadResponse') },
    )
  }
  assert.equal(await transcribeWithServer({ server: SERVER, apiKey: null, audio: AUDIO }, fakeFetch(() => json({ text: '' })).fetch), '')
})

test('a server that takes too long is reported with the time limit', async () => {
  const timedOut = fakeFetch(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') })
  await assert.rejects(
    transcribeWithServer({ server: SERVER, apiKey: null, audio: AUDIO }, timedOut.fetch),
    { message: t('errors.voice.serverTimeout', { url: ENDPOINT, seconds: VOICE_SERVER_TIMEOUT_MS / 1000 }) },
  )
})

test('a server that cannot be reached is reported with the reason', async () => {
  const refused = fakeFetch(() => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8000') }) })
  await assert.rejects(
    transcribeWithServer({ server: SERVER, apiKey: null, audio: AUDIO }, refused.fetch),
    { message: t('errors.voice.serverUnreachable', { url: ENDPOINT, reason: 'connect ECONNREFUSED 127.0.0.1:8000' }) },
  )
})
