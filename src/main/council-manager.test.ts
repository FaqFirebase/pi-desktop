import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  buildConsultantLaunch,
  runConsultants,
  runArbiter,
  type ConsultantLaunch,
  type SpawnConsultant,
} from './council-manager'
import { buildConsultantCommand, councilAgentLabel } from '../shared/council-config'
import type { CouncilAgentId, ConsultantResult } from '../shared/council-config'
import type { PiCli } from './pi-rpc-manager'
import { describePiStartFailure, type PiStartFailure } from './pi-binary-resolution'
import { NO_CWD_EXE_SEARCH_VARIABLE, disableCwdExecutableSearch } from './windows-exe-search'
import { t } from '../shared/i18n'

function fakeSpawn(map: Record<string, { ok: boolean; output?: string; error?: string; timedOut?: boolean }>): SpawnConsultant {
  return async (id: CouncilAgentId) => {
    const r = map[id] ?? { ok: false, error: 'unconfigured' }
    return { ok: r.ok, output: r.output ?? '', error: r.error, timedOut: r.timedOut }
  }
}

// --- buildConsultantLaunch: what spawn() gets for each consultant ---

/** Every consultant flag is metacharacter-free, so cmd.exe escaping must leave them byte-identical. */
const CLAUDE_ARGS = ['-p', '--permission-mode', 'plan', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']
const PI_ARGS = ['-p', '--mode', 'json', '--no-session', '--exclude-tools', 'bash,edit,write']
const OMP_ARGS = ['-p', '--mode', 'json', '--no-session', '--tools', 'read,grep,glob']

/** A resolved engine. needsShell is true only for a Windows shim, and never with useNode. */
function piCli(overrides: Partial<PiCli> = {}): PiCli {
  return {
    kind: 'pi',
    script: '/usr/local/bin/pi',
    node: '/usr/bin/node',
    useNode: false,
    needsShell: false,
    found: true,
    nodeFound: true,
    failureReason: null,
    ...overrides,
  }
}

/** The app environment after Windows startup added the current-folder search switch. */
function windowsAppEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { Path: String.raw`C:\Windows\system32` }
  disableCwdExecutableSearch(env, 'win32')
  return env
}

// The launch tests change the startup state; leave it as this host's startup does.
after(() => disableCwdExecutableSearch({}, process.platform))

function launched(result: ConsultantLaunch | { error: string }): ConsultantLaunch {
  if ('error' in result) assert.fail(`expected a launch, got the refusal: ${result.error}`)
  return result
}

/** The spawn() program, argv and shell flag of a launch, without its environment. */
function command(launch: ConsultantLaunch): { file: string; args: string[]; shell: boolean } {
  return { file: launch.file, args: launch.args, shell: launch.shell }
}

test('a Windows .cmd consultant runs through cmd.exe, quoted, and keeps the switch for its shim', () => {
  const launch = launched(buildConsultantLaunch(
    { id: 'claude', executable: String.raw`C:\Program Files\nodejs\claude.cmd` },
    true,
    windowsAppEnv(),
  ))
  assert.deepEqual(command(launch), {
    file: String.raw`"C:\Program Files\nodejs\claude.cmd"`,
    args: CLAUDE_ARGS,
    shell: true,
  })
  // cmd.exe resolves the shim's bare `node` with the switch: from PATH, not from the workspace.
  assert.equal(NO_CWD_EXE_SEARCH_VARIABLE in launch.env, true)
})

test('a Windows .exe consultant starts directly, without cmd.exe or the switch', () => {
  const executable = String.raw`C:\Users\Tom Smith\.local\bin\claude.exe`
  const launch = launched(buildConsultantLaunch({ id: 'claude', executable }, true, windowsAppEnv()))
  assert.deepEqual(command(launch), { file: executable, args: CLAUDE_ARGS, shell: false })
  assert.equal(NO_CWD_EXE_SEARCH_VARIABLE in launch.env, false)
})

test('the Pi consultant and the arbiter run cli.js under Node, never through cmd.exe', () => {
  // cmd.exe would open a .js file with its file association instead of running Pi.
  const cli = piCli({
    script: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js`,
    node: String.raw`C:\Program Files\nodejs\node.exe`,
    useNode: true,
  })
  const launch = launched(buildConsultantLaunch({ id: 'pi', cli }, true, windowsAppEnv()))
  assert.deepEqual(command(launch), { file: cli.node, args: [cli.script, ...PI_ARGS], shell: false })
  assert.equal(NO_CWD_EXE_SEARCH_VARIABLE in launch.env, false)
})

test('a Pi shim path is escaped for the cmd.exe hop and keeps the switch', () => {
  const cli = piCli({ script: String.raw`C:\Users\Tom & Jerry\100%\pi.cmd`, needsShell: true })
  const launch = launched(buildConsultantLaunch({ id: 'pi', cli }, true, windowsAppEnv()))
  assert.deepEqual(command(launch), {
    file: String.raw`"C:\Users\Tom & Jerry\100"^%"\pi.cmd"`,
    args: PI_ARGS,
    shell: true,
  })
  assert.equal(NO_CWD_EXE_SEARCH_VARIABLE in launch.env, true)
})

test('an OMP engine plans with its native read-only tool allowlist', () => {
  const cli = piCli({ kind: 'omp', script: String.raw`C:\Users\u\.bun\bin\omp.exe` })
  const launch = launched(buildConsultantLaunch({ id: 'pi', cli }, true, windowsAppEnv()))
  assert.deepEqual(command(launch), { file: cli.script, args: OMP_ARGS, shell: false })
})

test('a consultant that was not found is reported, never spawned by bare name', () => {
  // Windows looks a bare name up in the working directory, the workspace, first.
  for (const id of ['claude', 'codex'] as const) {
    assert.deepEqual(
      buildConsultantLaunch({ id, executable: null }, true, windowsAppEnv()),
      { error: t('errors.council.agentNotFound', { agent: councilAgentLabel(id) }) },
      id,
    )
  }
  const failureReason: PiStartFailure = { kind: 'node-not-found', node: 'node.exe' }
  assert.deepEqual(
    buildConsultantLaunch(
      { id: 'pi', cli: piCli({ useNode: true, nodeFound: false, failureReason }) },
      true,
      windowsAppEnv(),
    ),
    { error: describePiStartFailure(failureReason, t) },
  )
})

test('every consultant passes through byte-identically off Windows', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
  for (const id of ['claude', 'codex'] as const) {
    const executable = `/usr/local/bin/my agents/${id}`
    const launch = launched(buildConsultantLaunch({ id, executable }, false, env))
    assert.deepEqual(command(launch), { file: executable, args: buildConsultantCommand(id, executable).args, shell: false }, id)
  }
  const cli = piCli({ script: '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', useNode: true })
  const launch = launched(buildConsultantLaunch({ id: 'pi', cli }, false, env))
  assert.deepEqual(command(launch), { file: cli.node, args: [cli.script, ...PI_ARGS], shell: false })
})

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
