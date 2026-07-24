import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateCouncilConfig,
  DEFAULT_COUNCIL_CONFIG,
  type CouncilConfig,
} from './council-config'

test('default config is valid', () => {
  assert.deepEqual(validateCouncilConfig(DEFAULT_COUNCIL_CONFIG), [])
})

test('default config is disabled', () => {
  assert.equal(DEFAULT_COUNCIL_CONFIG.enabled, false)
})

test('flags timeout below minimum', () => {
  const cfg: CouncilConfig = { ...DEFAULT_COUNCIL_CONFIG, timeoutSeconds: 1 }
  assert.ok(validateCouncilConfig(cfg).some((e) => e.toLowerCase().includes('timeout')))
})

test('flags timeout above maximum', () => {
  const cfg: CouncilConfig = { ...DEFAULT_COUNCIL_CONFIG, timeoutSeconds: 10_000 }
  assert.ok(validateCouncilConfig(cfg).some((e) => e.toLowerCase().includes('timeout')))
})

test('flags non-finite timeout', () => {
  const cfg: CouncilConfig = { ...DEFAULT_COUNCIL_CONFIG, timeoutSeconds: Number.NaN }
  assert.ok(validateCouncilConfig(cfg).some((e) => e.toLowerCase().includes('timeout')))
})

test('flags unknown consensus mode', () => {
  const cfg = { ...DEFAULT_COUNCIL_CONFIG, consensusMode: 'loop' } as unknown as CouncilConfig
  assert.ok(validateCouncilConfig(cfg).some((e) => e.toLowerCase().includes('consensus')))
})

import {
  resolveActiveMembers,
  hasQuorum,
  type ConsultantResult,
} from './council-config'

const allDetected = { pi: true, claude: true, codex: true }

test('resolves checked-and-detected members', () => {
  const r = resolveActiveMembers(DEFAULT_COUNCIL_CONFIG_ENABLED(), allDetected)
  assert.deepEqual(r.active.sort(), ['claude', 'codex', 'pi'])
  assert.equal(r.canRun, true)
})

test('excludes unchecked members', () => {
  const cfg = DEFAULT_COUNCIL_CONFIG_ENABLED()
  cfg.members.codex = false
  const r = resolveActiveMembers(cfg, allDetected)
  assert.deepEqual(r.active.sort(), ['claude', 'pi'])
  assert.equal(r.canRun, true)
})

test('excludes undetected members', () => {
  const r = resolveActiveMembers(DEFAULT_COUNCIL_CONFIG_ENABLED(), { pi: false, claude: true, codex: false })
  assert.deepEqual(r.active, ['claude'])
})

test('refuses with fewer than two members available', () => {
  const r = resolveActiveMembers(DEFAULT_COUNCIL_CONFIG_ENABLED(), { pi: true, claude: false, codex: false })
  assert.equal(r.canRun, false)
  assert.ok((r.reason ?? '').toLowerCase().includes('at least'))
})

test('refuses when feature disabled', () => {
  const r = resolveActiveMembers(DEFAULT_COUNCIL_CONFIG, allDetected)
  assert.equal(r.canRun, false)
})

test('hasQuorum true when any consultant contributed', () => {
  const results: ConsultantResult[] = [
    { id: 'claude', status: 'errored', error: 'x' },
    { id: 'codex', status: 'contributed', plan: 'p' },
  ]
  assert.equal(hasQuorum(results), true)
})

test('hasQuorum false when none contributed', () => {
  const results: ConsultantResult[] = [
    { id: 'claude', status: 'errored', error: 'x' },
    { id: 'codex', status: 'timed-out' },
  ]
  assert.equal(hasQuorum(results), false)
})

// helper: an enabled copy of the default config
function DEFAULT_COUNCIL_CONFIG_ENABLED(): CouncilConfig {
  return { ...DEFAULT_COUNCIL_CONFIG, enabled: true, members: { pi: true, claude: true, codex: true } }
}

import {
  buildConsultantPrompt,
  buildConsensusPrompt,
  buildDebatePrompt,
  buildConsultantCommand,
  buildArbiterRevisionPrompt,
  buildImplementationPrompt,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  parsePiStreamLine,
  clampTimeoutSeconds,
  MIN_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
} from './council-config'

test('clampTimeoutSeconds keeps in-range values, rounding', () => {
  assert.equal(clampTimeoutSeconds(90), 90)
  assert.equal(clampTimeoutSeconds(90.4), 90)
})

test('clampTimeoutSeconds clamps to bounds', () => {
  assert.equal(clampTimeoutSeconds(1), MIN_TIMEOUT_SECONDS)
  assert.equal(clampTimeoutSeconds(99999), MAX_TIMEOUT_SECONDS)
})

test('clampTimeoutSeconds falls back to default on non-finite', () => {
  assert.equal(clampTimeoutSeconds(Number.NaN), DEFAULT_COUNCIL_CONFIG.timeoutSeconds)
})

test('consultant prompt forbids edits and embeds request', () => {
  const p = buildConsultantPrompt('Build a gallery site')
  assert.ok(p.includes('Build a gallery site'))
  assert.ok(/do not (modify|edit|change|write)/i.test(p))
  assert.ok(/plan/i.test(p))
})

test('consensus prompt includes request and every contributed plan, labeled', () => {
  const results: ConsultantResult[] = [
    { id: 'claude', status: 'contributed', plan: 'CLAUDE PLAN TEXT' },
    { id: 'codex', status: 'contributed', plan: 'CODEX PLAN TEXT' },
    { id: 'claude', status: 'errored', error: 'ignored' },
  ]
  const p = buildConsensusPrompt('Original request', results)
  assert.ok(p.includes('Original request'))
  assert.ok(p.includes('CLAUDE PLAN TEXT'))
  assert.ok(p.includes('CODEX PLAN TEXT'))
  assert.ok(p.toLowerCase().includes('claude'))
  assert.ok(p.toLowerCase().includes('codex'))
  assert.ok(/do not (implement|start|build|write)/i.test(p))
  // Consultant output is delimited as untrusted data, not blended in as instructions.
  assert.ok(p.includes('BEGIN UNTRUSTED'), 'consultant plans should be delimited as untrusted data')
})

test('consensus prompt excludes non-contributed plans', () => {
  const results: ConsultantResult[] = [
    { id: 'claude', status: 'contributed', plan: 'KEPT' },
    { id: 'codex', status: 'timed-out' },
  ]
  const p = buildConsensusPrompt('req', results)
  assert.ok(p.includes('KEPT'))
  assert.ok(!p.includes('timed-out'))
})

test('arbiter revision prompt embeds request, prior plan, and feedback; forbids implementing', () => {
  const p = buildArbiterRevisionPrompt('Original request', 'PRIOR PLAN TEXT', 'Use Postgres instead of SQLite')
  assert.ok(p.includes('Original request'))
  assert.ok(p.includes('PRIOR PLAN TEXT'))
  assert.ok(p.includes('Use Postgres instead of SQLite'))
  assert.ok(/revise/i.test(p))
  assert.ok(/do not (implement|build|write)/i.test(p))
})

test('implementation prompt embeds the approved plan and asks to implement', () => {
  const p = buildImplementationPrompt('APPROVED PLAN BODY')
  assert.ok(p.includes('APPROVED PLAN BODY'))
  assert.ok(/implement/i.test(p))
  // The vetted plan is all that crosses over — no reference to consultant output.
  assert.ok(/approved/i.test(p))
})

test('debate prompt shows other plans and asks for a revision', () => {
  const others: ConsultantResult[] = [{ id: 'codex', status: 'contributed', plan: 'OTHER PLAN' }]
  const p = buildDebatePrompt('req', 'claude', others)
  assert.ok(p.includes('OTHER PLAN'))
  assert.ok(/revis|critiq/i.test(p))
  assert.ok(p.includes('BEGIN UNTRUSTED'), "other agents' plans should be delimited as untrusted data")
})

test('consultant command uses read-only flags per agent', () => {
  const claude = buildConsultantCommand('claude', '/usr/bin/claude')
  assert.equal(claude.file, '/usr/bin/claude')
  assert.ok(claude.args.includes('-p'))

  const codex = buildConsultantCommand('codex', '/usr/bin/codex')
  assert.equal(codex.file, '/usr/bin/codex')
  assert.ok(codex.args.includes('exec'))
})

test('consultant command never puts the prompt in argv (stdin-only delivery)', () => {
  // Untrusted prompt text must not reach the command line — on Windows the args
  // pass through cmd.exe and would be open to shell-metacharacter injection.
  for (const id of ['pi', 'claude', 'codex'] as const) {
    const { args } = buildConsultantCommand(id, '/usr/bin/agent')
    assert.ok(!args.some((a) => /prompt/i.test(a)), `${id} argv should carry no prompt`)
  }
})

test('claude command requests stream-json for live output', () => {
  const claude = buildConsultantCommand('claude', '/usr/bin/claude')
  assert.ok(claude.args.includes('--output-format'))
  assert.ok(claude.args.includes('stream-json'))
  assert.ok(claude.args.includes('--include-partial-messages'))
  assert.ok(claude.args.includes('--verbose'))
})

test('parseClaudeStreamLine extracts a text delta', () => {
  const line = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
  })
  assert.deepEqual(parseClaudeStreamLine(line), { delta: 'Hello' })
})

test('parseClaudeStreamLine extracts the final result', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'FINAL PLAN' })
  assert.deepEqual(parseClaudeStreamLine(line), { final: 'FINAL PLAN' })
})

test('parseClaudeStreamLine ignores irrelevant lines and bad JSON', () => {
  assert.deepEqual(parseClaudeStreamLine(''), {})
  assert.deepEqual(parseClaudeStreamLine('not json'), {})
  assert.deepEqual(parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init' })), {})
})

test('codex command requests JSONL streaming and read-only sandbox', () => {
  const codex = buildConsultantCommand('codex', '/usr/bin/codex')
  assert.ok(codex.args.includes('exec'))
  assert.ok(codex.args.includes('--json'))
  assert.ok(codex.args.includes('--sandbox'))
  assert.ok(codex.args.includes('read-only'))
})

test('parseCodexStreamLine extracts the agent message as plan', () => {
  const line = JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'CODEX PLAN' },
  })
  assert.deepEqual(parseCodexStreamLine(line), { plan: 'CODEX PLAN' })
})

test('parseCodexStreamLine returns non-message items as live-only display', () => {
  const line = JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'reasoning', text: 'thinking about files' },
  })
  assert.deepEqual(parseCodexStreamLine(line), { display: 'thinking about files' })
})

test('parseCodexStreamLine ignores non-item events and bad JSON', () => {
  assert.deepEqual(parseCodexStreamLine(JSON.stringify({ type: 'turn.started' })), {})
  assert.deepEqual(parseCodexStreamLine('not json'), {})
  assert.deepEqual(parseCodexStreamLine(''), {})
})

test('pi command runs read-only json mode with bash excluded', () => {
  const pi = buildConsultantCommand('pi', '/usr/bin/pi')
  assert.equal(pi.file, '/usr/bin/pi')
  assert.ok(pi.args.includes('-p'))
  assert.ok(pi.args.includes('--mode'))
  assert.ok(pi.args.includes('json'))
  assert.ok(pi.args.includes('--exclude-tools'))
  // bash must be denied so an injected plan cannot run shell commands during
  // the supposedly read-only planning/arbitration run.
  const denied = pi.args[pi.args.indexOf('--exclude-tools') + 1] ?? ''
  assert.ok(denied.split(',').includes('bash'), 'pi read-only run must exclude bash')
  assert.ok(denied.split(',').includes('edit'))
  assert.ok(denied.split(',').includes('write'))
})

test('parsePiStreamLine extracts assistant text as plan', () => {
  const line = JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Plan part' },
  })
  assert.deepEqual(parsePiStreamLine(line), { plan: 'Plan part' })
})

test('parsePiStreamLine returns thinking as live-only display', () => {
  const line = JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' },
  })
  assert.deepEqual(parsePiStreamLine(line), { display: 'pondering' })
})

test('parsePiStreamLine ignores non-update events and bad JSON', () => {
  assert.deepEqual(parsePiStreamLine(JSON.stringify({ type: 'turn_start' })), {})
  assert.deepEqual(parsePiStreamLine('not json'), {})
  assert.deepEqual(parsePiStreamLine(''), {})
})
