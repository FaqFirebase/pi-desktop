import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runConsultants, type SpawnConsultant } from './council-manager'
import type { CouncilAgentId } from '../shared/council-config'

function fakeSpawn(map: Record<string, { ok: boolean; output?: string; error?: string; timedOut?: boolean }>): SpawnConsultant {
  return async (id: CouncilAgentId) => {
    const r = map[id] ?? { ok: false, error: 'unconfigured' }
    return { ok: r.ok, output: r.output ?? '', error: r.error, timedOut: r.timedOut }
  }
}

test('arbiter mode: contributed and errored are labeled', async () => {
  const results = await runConsultants(
    { request: 'r', members: ['claude', 'codex'], cwd: '/tmp', timeoutSeconds: 1, consensusMode: 'arbiter' },
    { spawnConsultant: fakeSpawn({ claude: { ok: true, output: 'PLAN A' }, codex: { ok: false, error: 'boom' } }) },
  )
  const claude = results.find((r) => r.id === 'claude')!
  const codex = results.find((r) => r.id === 'codex')!
  assert.equal(claude.status, 'contributed')
  assert.equal(claude.plan, 'PLAN A')
  assert.equal(codex.status, 'errored')
  assert.equal(codex.error, 'boom')
})

test('timed-out spawn maps to timed-out status', async () => {
  const results = await runConsultants(
    { request: 'r', members: ['claude'], cwd: '/tmp', timeoutSeconds: 1, consensusMode: 'arbiter' },
    { spawnConsultant: fakeSpawn({ claude: { ok: false, timedOut: true } }) },
  )
  assert.equal(results[0].status, 'timed-out')
})

test('debate mode performs a second spawn round per member', async () => {
  const calls: Array<{ id: CouncilAgentId; round: number }> = []
  const spawn: SpawnConsultant = async (id, _prompt, _cwd, _ms) => {
    const round = calls.filter((c) => c.id === id).length + 1
    calls.push({ id, round })
    return { ok: true, output: `PLAN ${id} r${round}` }
  }
  const results = await runConsultants(
    { request: 'r', members: ['claude', 'codex'], cwd: '/tmp', timeoutSeconds: 1, consensusMode: 'debate' },
    { spawnConsultant: spawn },
  )
  assert.equal(calls.length, 4)
  assert.ok(results.find((r) => r.id === 'claude')!.plan!.includes('r2'))
})

test('onProgress receives streamed chunks tagged by consultant', async () => {
  const events: Array<{ id: CouncilAgentId; chunk: string }> = []
  const spawn: SpawnConsultant = async (id, _prompt, _cwd, _ms, onChunk) => {
    onChunk?.(`${id}-chunk`)
    return { ok: true, output: `PLAN ${id}` }
  }
  await runConsultants(
    { request: 'r', members: ['claude', 'codex'], cwd: '/tmp', timeoutSeconds: 1, consensusMode: 'arbiter' },
    { spawnConsultant: spawn, onProgress: (id, chunk) => events.push({ id, chunk }) },
  )
  assert.ok(events.some((e) => e.id === 'claude' && e.chunk === 'claude-chunk'))
  assert.ok(events.some((e) => e.id === 'codex' && e.chunk === 'codex-chunk'))
})
