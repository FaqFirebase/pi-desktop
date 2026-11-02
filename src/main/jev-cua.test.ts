import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeCuaUseRequest, parseCuaJudgment, type JevFetch, type JevFetchResponse } from './jev-cua'

// ─── parseCuaJudgment ───────────────────────────────────────────────────────

test('a complete valid judgment passes and is returned normalized', () => {
  const judgment = parseCuaJudgment({
    needsComputer: true,
    backend: 'docker-vm',
    confidence: 0.8,
    reason: 'GUI task in a sandbox',
    extra: 'dropped',
  })
  assert.deepEqual(judgment, {
    needsComputer: true,
    backend: 'docker-vm',
    confidence: 0.8,
    reason: 'GUI task in a sandbox',
  })
})

test('reason is optional', () => {
  const judgment = parseCuaJudgment({ needsComputer: false, backend: 'main-os', confidence: 1 })
  assert.deepEqual(judgment, { needsComputer: false, backend: 'main-os', confidence: 1 })
  assert.ok(!('reason' in judgment))
})

test('every ComputerBackend member of the union is accepted', () => {
  for (const backend of ['main-os', 'proxmox-vm', 'docker-host', 'docker-vm', 'auto'] as const) {
    assert.equal(parseCuaJudgment({ needsComputer: true, backend, confidence: 0 }).backend, backend)
  }
})

test('non-objects are refused', () => {
  for (const raw of [null, undefined, 'auto', 42, [], [{ needsComputer: true }]]) {
    assert.throws(() => parseCuaJudgment(raw), TypeError, `must refuse ${JSON.stringify(raw)}`)
  }
})

test('needsComputer must be a boolean', () => {
  assert.throws(() => parseCuaJudgment({ needsComputer: 'yes', backend: 'auto', confidence: 0.5 }))
  assert.throws(() => parseCuaJudgment({ needsComputer: 1, backend: 'auto', confidence: 0.5 }))
  assert.throws(() => parseCuaJudgment({ backend: 'auto', confidence: 0.5 }))
})

test('backend must be in the ComputerBackend union', () => {
  assert.throws(() => parseCuaJudgment({ needsComputer: true, backend: 'proxmox', confidence: 0.5 }))
  assert.throws(() => parseCuaJudgment({ needsComputer: true, backend: null, confidence: 0.5 }))
})

test('confidence must be a finite number within 0..1', () => {
  for (const confidence of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0.8', undefined]) {
    assert.throws(
      () => parseCuaJudgment({ needsComputer: true, backend: 'docker-host', confidence }),
      TypeError,
      `must reject confidence ${String(confidence)}`,
    )
  }
})

test('reason must be a string when present', () => {
  assert.throws(() => parseCuaJudgment({ needsComputer: true, backend: 'auto', confidence: 0.5, reason: 7 }))
})

// ─── judgeCuaUseRequest ─────────────────────────────────────────────────────

const FALLBACK = { needsComputer: true, backend: 'docker-vm', confidence: 0, reason: 'jev-unavailable' }

function systemOneBody(noul: number, choice: string, confidence: number): unknown {
  return {
    model: 'jev-latest',
    answers: {
      needsComputer: { type: 'noul', noul },
      backend: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } },
    },
    usage: { input_tokens: 120, output_tokens: 12 },
  }
}

function jsonResponse(body: unknown, ok = true, status = 200): JevFetchResponse {
  return { ok, status, json: async () => body }
}

test('without a key the fallback is returned and no request is made', async () => {
  let called = 0
  const fetchSpy: JevFetch = async () => {
    called += 1
    return jsonResponse(systemOneBody(0.9, 'main-os', 0.9))
  }
  const judgment = await judgeCuaUseRequest('open notepad', null, fetchSpy)
  assert.deepEqual(judgment, FALLBACK)
  assert.equal(called, 0)
})

test('a valid response maps to a CuaJudgment and the request is well-formed', async () => {
  let seenUrl = ''
  let seenInit: Parameters<JevFetch>[1] | undefined
  const fetchStub: JevFetch = async (url, init) => {
    seenUrl = url
    seenInit = init
    return jsonResponse(systemOneBody(0.93, 'docker-vm', 0.61))
  }
  const judgment = await judgeCuaUseRequest('click the save button in GIMP', 'ts_test_key', fetchStub)

  assert.equal(judgment.needsComputer, true)
  assert.equal(judgment.backend, 'docker-vm')
  assert.equal(judgment.confidence, 0.61)
  assert.match(String(judgment.reason), /needsComputer 0\.93; backend docker-vm at 0\.61/)

  assert.equal(seenUrl, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(seenInit?.method, 'POST')
  assert.equal(seenInit?.headers.Authorization, 'Bearer ts_test_key')
  const sent = JSON.parse(String(seenInit?.body)) as {
    model: string
    state: { userRequest: string }
    questions: { needsComputer: { type: string }; backend: { type: string; criteria: Record<string, string> } }
  }
  assert.equal(sent.model, 'jev-latest')
  assert.deepEqual(sent.state, { userRequest: 'click the save button in GIMP' })
  assert.equal(sent.questions.needsComputer.type, 'noul')
  assert.equal(sent.questions.backend.type, 'choice')
  assert.deepEqual(Object.keys(sent.questions.backend.criteria).sort(), [
    'docker-host',
    'docker-vm',
    'main-os',
    'proxmox-vm',
  ])
})

test('a low noul probability means needsComputer false', async () => {
  const fetchStub: JevFetch = async () => jsonResponse(systemOneBody(0.2, 'main-os', 0.55))
  const judgment = await judgeCuaUseRequest('write a haiku', 'ts_test_key', fetchStub)
  assert.equal(judgment.needsComputer, false)
  assert.equal(judgment.backend, 'main-os')
  assert.equal(judgment.confidence, 0.55)
})

test('an HTTP error degrades to the fallback', async () => {
  const fetchStub: JevFetch = async () => jsonResponse({ detail: 'quota exceeded' }, false, 429)
  assert.deepEqual(await judgeCuaUseRequest('anything', 'ts_test_key', fetchStub), FALLBACK)
})

test('a transport failure degrades to the fallback', async () => {
  const fetchStub: JevFetch = async () => {
    throw new Error('socket closed')
  }
  assert.deepEqual(await judgeCuaUseRequest('anything', 'ts_test_key', fetchStub), FALLBACK)
})

test('malformed answers degrade to the fallback', async () => {
  const bodies: unknown[] = [
    {},
    { answers: null },
    { answers: { needsComputer: { type: 'noul', noul: 1.4 }, backend: { type: 'choice', choice: 'docker-vm', confidence: 0.5 } } },
    { answers: { needsComputer: { type: 'noul', noul: 0.9 } } },
    { answers: { needsComputer: { type: 'noul', noul: 0.9 }, backend: { type: 'choice', choice: 'windows', confidence: 0.5 } } },
    { answers: { needsComputer: { type: 'noul', noul: 0.9 }, backend: { type: 'choice', choice: 'auto', confidence: 1.2 } } },
  ]
  for (const body of bodies) {
    const fetchStub: JevFetch = async () => jsonResponse(body)
    assert.deepEqual(await judgeCuaUseRequest('anything', 'ts_test_key', fetchStub), FALLBACK)
  }
})
