import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runConsultants, runArbiter, type SpawnConsultant } from './council-manager'
import type { CouncilAgentId, ConsultantResult } from '../shared/council-config'

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

test('runArbiter merges via a read-only Pi spawn carrying the consultant plans', async () => {
  const seen: { id: CouncilAgentId; prompt: string } = { id: 'claude', prompt: '' }
  const spawn: SpawnConsultant = async (id, prompt) => {
    seen.id = id
    seen.prompt = prompt
    return { ok: true, output: 'MERGED PLAN' }
  }
  const results: ConsultantResult[] = [
    { id: 'claude', status: 'contributed', plan: 'CLAUDE PLAN' },
    { id: 'codex', status: 'contributed', plan: 'CODEX PLAN' },
  ]
  const outcome = await runArbiter(
    { kind: 'merge', request: 'build it', results },
    '/tmp',
    1,
    { spawnConsultant: spawn },
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.output, 'MERGED PLAN')
  // The arbiter is always Pi (the read-only builder), and the untrusted plans
  // are embedded into its prompt.
  assert.equal(seen.id, 'pi')
  assert.ok(seen.prompt.includes('CLAUDE PLAN'))
  assert.ok(seen.prompt.includes('CODEX PLAN'))
})

test('runArbiter revise embeds the prior plan and feedback', async () => {
  let captured = ''
  const spawn: SpawnConsultant = async (_id, prompt) => {
    captured = prompt
    return { ok: true, output: 'REVISED PLAN' }
  }
  const outcome = await runArbiter(
    { kind: 'revise', request: 'build it', plan: 'PRIOR PLAN', feedback: 'use Postgres' },
    '/tmp',
    1,
    { spawnConsultant: spawn },
  )
  assert.equal(outcome.output, 'REVISED PLAN')
  assert.ok(captured.includes('PRIOR PLAN'))
  assert.ok(captured.includes('use Postgres'))
})

test('runArbiter forwards streamed chunks to onProgress', async () => {
  const chunks: string[] = []
  const spawn: SpawnConsultant = async (_id, _prompt, _cwd, _ms, onChunk) => {
    onChunk?.('partial plan')
    return { ok: true, output: 'DONE' }
  }
  await runArbiter(
    { kind: 'merge', request: 'r', results: [] },
    '/tmp',
    1,
    { spawnConsultant: spawn, onProgress: (chunk) => chunks.push(chunk) },
  )
  assert.deepEqual(chunks, ['partial plan'])
})
