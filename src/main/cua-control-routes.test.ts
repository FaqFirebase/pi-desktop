import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  handleControlRequest,
  isAuthorized,
  parseControlBody,
  type ControlOps,
  type ControlRequest,
} from './cua-control-routes'
import type { ComputerBackend } from '../shared/ipc-contracts'

const TOKEN = 'a'.repeat(64)
const AUTH = `Bearer ${TOKEN}`

interface Calls {
  open: ComputerBackend[]
  close: number
  status: number
  exec: string[]
}

function stubOps(overrides: Partial<ControlOps> = {}): { ops: ControlOps; calls: Calls } {
  const calls: Calls = { open: [], close: 0, status: 0, exec: [] }
  const ops: ControlOps = {
    open: async (backend) => {
      calls.open.push(backend)
      return { success: true, sessionId: 'space-1', viewerUrl: 'http://127.0.0.1:38100/viewer/#ticket=x', backend }
    },
    close: async () => {
      calls.close += 1
      return { success: true }
    },
    status: () => {
      calls.status += 1
      return { open: true, sessionId: 'space-1', backend: 'docker-vm' }
    },
    exec: async (command) => {
      calls.exec.push(command)
      return { success: true, stdout: 'ok\n', stderr: '', exitCode: 0 }
    },
    ...overrides,
  }
  return { ops, calls }
}

function req(partial: Partial<ControlRequest> & Pick<ControlRequest, 'method' | 'path'>): ControlRequest {
  return { authorization: AUTH, body: '', ...partial }
}

// ─── Authentification ───────────────────────────────────────────────────────

test('missing Authorization header is 401 and calls nothing', async () => {
  const { ops, calls } = stubOps()
  const res = await handleControlRequest(req({ method: 'GET', path: '/computer/status', authorization: undefined }), TOKEN, ops)
  assert.equal(res.status, 401)
  assert.equal(calls.status, 0)
})

test('wrong token or wrong scheme is 401', async () => {
  const { ops } = stubOps()
  for (const authorization of [`Bearer ${'b'.repeat(64)}`, AUTH.slice(2), `Basic ${TOKEN}`, '']) {
    const res = await handleControlRequest(req({ method: 'GET', path: '/computer/status', authorization }), TOKEN, ops)
    assert.equal(res.status, 401, `must refuse ${JSON.stringify(authorization)}`)
  }
})

test('isAuthorized tolerates tokens of different lengths without throwing', () => {
  assert.equal(isAuthorized('Bearer short', 'a'.repeat(64)), false)
  assert.equal(isAuthorized(AUTH, TOKEN), true)
})

// ─── Routage et méthodes ────────────────────────────────────────────────────

test('unknown route is 404, wrong method is 405', async () => {
  const { ops } = stubOps()
  assert.equal((await handleControlRequest(req({ method: 'GET', path: '/computer/nope' }), TOKEN, ops)).status, 404)
  assert.equal((await handleControlRequest(req({ method: 'GET', path: '/' }), TOKEN, ops)).status, 404)
  assert.equal((await handleControlRequest(req({ method: 'GET', path: '/computer/open' }), TOKEN, ops)).status, 405)
  assert.equal((await handleControlRequest(req({ method: 'POST', path: '/computer/status' }), TOKEN, ops)).status, 405)
  assert.equal((await handleControlRequest(req({ method: 'GET', path: '/computer/close' }), TOKEN, ops)).status, 405)
  assert.equal((await handleControlRequest(req({ method: 'GET', path: '/computer/exec' }), TOKEN, ops)).status, 405)
})

test('status passthrough returns the handler state as JSON body', async () => {
  const { ops, calls } = stubOps()
  const res = await handleControlRequest(req({ method: 'GET', path: '/computer/status' }), TOKEN, ops)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { open: true, sessionId: 'space-1', backend: 'docker-vm' })
  assert.equal(calls.status, 1)
})

test('close passthrough returns the handler result', async () => {
  const { ops } = stubOps({ close: async () => ({ success: false, error: 'Aucune session CUA ouverte.' }) })
  const res = await handleControlRequest(req({ method: 'POST', path: '/computer/close' }), TOKEN, ops)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: false, error: 'Aucune session CUA ouverte.' })
})

// ─── /computer/open : validation du backend ─────────────────────────────────

test('open defaults to auto when the body is absent, empty, or null-backend', async () => {
  for (const body of ['', '{}', '{"backend":null}']) {
    const { ops, calls } = stubOps()
    const res = await handleControlRequest(req({ method: 'POST', path: '/computer/open', body }), TOKEN, ops)
    assert.equal(res.status, 200)
    assert.deepEqual(calls.open, ['auto'])
  }
})

test('open accepts every panel backend verbatim', async () => {
  for (const backend of ['docker-vm', 'docker-host', 'proxmox-vm', 'main-os', 'auto'] as const) {
    const { ops, calls } = stubOps()
    const res = await handleControlRequest(req({ method: 'POST', path: '/computer/open', body: JSON.stringify({ backend }) }), TOKEN, ops)
    assert.equal(res.status, 200)
    assert.deepEqual(calls.open, [backend])
    assert.deepEqual(res.body, {
      success: true,
      sessionId: 'space-1',
      viewerUrl: 'http://127.0.0.1:38100/viewer/#ticket=x',
      backend,
    })
  }
})

test('open refuses unknown or non-string backends without calling ops', async () => {
  for (const body of ['{"backend":"browser"}', '{"backend":42}', '{"backend":["auto"]}', '{"backend":"  "}', '{"backend":"DOCKER-VM"}']) {
    const { ops, calls } = stubOps()
    const res = await handleControlRequest(req({ method: 'POST', path: '/computer/open', body }), TOKEN, ops)
    assert.equal(res.status, 400, `must refuse ${body}`)
    assert.equal(calls.open.length, 0)
  }
})

// ─── /computer/exec : validation de la commande ─────────────────────────────

test('exec passes the exact command string through', async () => {
  const command = "echo 'hi there' && ls -la /tmp"
  const { ops, calls } = stubOps()
  const res = await handleControlRequest(req({ method: 'POST', path: '/computer/exec', body: JSON.stringify({ command }) }), TOKEN, ops)
  assert.equal(res.status, 200)
  assert.deepEqual(calls.exec, [command])
})

test('exec refuses missing, empty, or non-string command', async () => {
  for (const body of ['{}', '{"command":""}', '{"command":"   "}', '{"command":null}', '{"command":7}', '{"command":true}']) {
    const { ops, calls } = stubOps()
    const res = await handleControlRequest(req({ method: 'POST', path: '/computer/exec', body }), TOKEN, ops)
    assert.equal(res.status, 400, `must refuse ${body}`)
    assert.equal(calls.exec.length, 0)
  }
})

test('exec surfaces the non-zero exit code as a normal result', async () => {
  const { ops } = stubOps({ exec: async () => ({ success: true, stdout: '', stderr: 'boom', exitCode: 3 }) })
  const res = await handleControlRequest(req({ method: 'POST', path: '/computer/exec', body: '{"command":"false"}' }), TOKEN, ops)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true, stdout: '', stderr: 'boom', exitCode: 3 })
})

// ─── parseControlBody ───────────────────────────────────────────────────────

test('parseControlBody treats empty and JSON null as absent, rejects non-objects', () => {
  assert.deepEqual(parseControlBody(''), {})
  assert.deepEqual(parseControlBody('   '), {})
  assert.deepEqual(parseControlBody('null'), {})
  assert.deepEqual(parseControlBody('{"a":1}'), { a: 1 })
  assert.equal(parseControlBody('[1,2]'), null)
  assert.equal(parseControlBody('"str"'), null)
  assert.equal(parseControlBody('{invalid'), null)
})

test('invalid JSON body is 400 on every POST route', async () => {
  const { ops, calls } = stubOps()
  for (const path of ['/computer/open', '/computer/close', '/computer/exec']) {
    const res = await handleControlRequest(req({ method: 'POST', path, body: 'not json {' }), TOKEN, ops)
    assert.equal(res.status, 400, path)
  }
  assert.deepEqual(calls, { open: [], close: 0, status: 0, exec: [] })
})
