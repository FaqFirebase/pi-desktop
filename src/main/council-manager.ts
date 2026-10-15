import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type { CouncilAgentId, ConsensusMode, ConsultantResult } from '../shared/council-config'
import {
  buildConsultantPrompt,
  buildConsensusPrompt,
  buildArbiterRevisionPrompt,
  buildDebatePrompt,
  buildConsultantCommand,
  councilAgentLabel,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  parsePiStreamLine,
} from '../shared/council-config'
import { detectAgents } from './agent-detection'
import { escapeCmdSpawn } from './cmd-escape'
import { describePiStartFailure, isCmdShim } from './pi-binary-resolution'
import { buildPiInvocation, buildPiRunEnv, getPiCli, type PiCli } from './pi-rpc-manager'
import { childProcessEnv } from './windows-exe-search'
import { t } from '../shared/i18n'

const IS_WINDOWS = process.platform === 'win32'
const MS_PER_SECOND = 1000
const FORCE_KILL_TIMEOUT_MS = 3000

export interface SpawnOutcome {
  ok: boolean
  output: string
  error?: string
  timedOut?: boolean
}

/** Called with each readable text chunk as a consultant produces output. */
export type ConsultantChunkHandler = (chunk: string) => void

/** Injectable spawn so orchestration is testable without real CLIs. */
export type SpawnConsultant = (
  id: CouncilAgentId,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onChunk?: ConsultantChunkHandler,
) => Promise<SpawnOutcome>

export interface RunConsultantsParams {
  request: string
  members: CouncilAgentId[]
  cwd: string
  timeoutSeconds: number
  consensusMode: ConsensusMode
}

export interface ConsultantDeps {
  spawnConsultant: SpawnConsultant
  /** Notified with live output chunks per consultant, for streaming to the UI. */
  onProgress?: (id: CouncilAgentId, chunk: string) => void
}

const MIN_DEBATE_PARTICIPANTS = 2

/** Map a spawn outcome to a labeled consultant result. */
function toResult(id: CouncilAgentId, outcome: SpawnOutcome): ConsultantResult {
  if (outcome.timedOut) return { id, status: 'timed-out' }
  if (!outcome.ok) return { id, status: 'errored', error: outcome.error ?? t('errors.council.unknownError') }
  return { id, status: 'contributed', plan: outcome.output.trim() }
}

/**
 * Run the consultant fan-out. Arbiter mode = one round. Debate mode = a second
 * round where each contributing member revises given the others' plans.
 */
export async function runConsultants(
  params: RunConsultantsParams,
  deps: ConsultantDeps,
): Promise<ConsultantResult[]> {
  const timeoutMs = params.timeoutSeconds * MS_PER_SECOND
  const prompt = buildConsultantPrompt(params.request)

  const forward = (id: CouncilAgentId): ConsultantChunkHandler => (chunk) => deps.onProgress?.(id, chunk)

  const round1 = await Promise.all(
    params.members.map(async (id) =>
      toResult(id, await deps.spawnConsultant(id, prompt, params.cwd, timeoutMs, forward(id))),
    ),
  )

  if (params.consensusMode !== 'debate') return round1

  const contributed = round1.filter((r) => r.status === 'contributed')
  if (contributed.length < MIN_DEBATE_PARTICIPANTS) return round1

  const round2 = await Promise.all(
    round1.map(async (r) => {
      if (r.status !== 'contributed') return r
      const others = contributed.filter((o) => o.id !== r.id)
      const debatePrompt = buildDebatePrompt(params.request, r.id, others)
      return toResult(r.id, await deps.spawnConsultant(r.id, debatePrompt, params.cwd, timeoutMs, forward(r.id)))
    }),
  )
  return round2
}

/**
 * Structured input for the arbiter step. `merge` combines contributed plans;
 * `revise` reworks an already-produced consensus plan given user feedback.
 */
export type ArbiterRequest =
  | { kind: 'merge'; request: string; results: ConsultantResult[] }
  | { kind: 'revise'; request: string; plan: string; feedback: string }

export interface ArbiterDeps {
  spawnConsultant: SpawnConsultant
  /** Notified with live output chunks from the arbiter, for streaming to the UI. */
  onProgress?: ConsultantChunkHandler
}

/**
 * Run the arbiter (Pi) as an isolated, read-only subprocess to merge or revise
 * the consensus plan. It runs read-only (via buildConsultantCommand('pi', …),
 * which excludes edit/write tools) precisely because consultant plans are
 * untrusted input: a poisoned plan cannot drive tool use here. Only the returned
 * plan text is later handed to the writable implementation session.
 */
export async function runArbiter(
  input: ArbiterRequest,
  cwd: string,
  timeoutSeconds: number,
  deps: ArbiterDeps,
): Promise<SpawnOutcome> {
  const prompt =
    input.kind === 'merge'
      ? buildConsensusPrompt(input.request, input.results)
      : buildArbiterRevisionPrompt(input.request, input.plan, input.feedback)
  const timeoutMs = timeoutSeconds * MS_PER_SECOND
  return deps.spawnConsultant('pi', prompt, cwd, timeoutMs, deps.onProgress)
}

/** Where a consultant's CLI was found: the engine resolution for Pi, detection for the others. */
export type ConsultantInstall =
  | { id: 'pi'; cli: PiCli }
  | { id: Exclude<CouncilAgentId, 'pi'>; executable: string | null }

/** Everything spawn() needs to start one consultant. */
export interface ConsultantLaunch {
  file: string
  args: string[]
  /** spawn()'s `shell`: true only for a Windows shim, which needs cmd.exe (see isCmdShim). */
  shell: boolean
  env: NodeJS.ProcessEnv
}

/**
 * How to start one consultant, or the reason it cannot start, in the
 * interface language. `inheritedEnv` is the app's own environment.
 *
 * The prompt is delivered over stdin, never as a CLI argument. A shim's args
 * pass through cmd.exe, so untrusted plan text on the command line would be
 * open to shell-metacharacter injection. All three CLIs read the prompt from
 * stdin. Node performs no quoting with shell:true, so the program path (which
 * may contain spaces or cmd metacharacters via the user profile directory)
 * and the flags are escaped for the cmd.exe traversal.
 *
 * The Pi consultant and the arbiter start like an RPC session: a cli.js runs
 * under Node, because cmd.exe would open a .js file with its file association.
 * A consultant that was not found is refused rather than spawned by its bare
 * name, which Windows would look up in the workspace (the working directory)
 * before PATH.
 */
export function buildConsultantLaunch(
  install: ConsultantInstall,
  isWindows: boolean,
  inheritedEnv: NodeJS.ProcessEnv,
): ConsultantLaunch | { error: string } {
  if (install.id === 'pi') {
    const { cli } = install
    if (cli.failureReason) return { error: describePiStartFailure(cli.failureReason, t) }
    const { args } = buildConsultantCommand(install.id, cli.script, cli.kind ?? 'pi')
    return {
      ...buildPiInvocation(cli, args),
      shell: cli.needsShell,
      // Only the Pi consultant is an agent engine run; ~/.pi/.env is not for other CLIs.
      env: buildPiRunEnv(cli.needsShell, inheritedEnv),
    }
  }
  if (!install.executable) {
    return { error: t('errors.council.agentNotFound', { agent: councilAgentLabel(install.id) }) }
  }
  const viaCmd = isCmdShim(isWindows, install.executable)
  const command = buildConsultantCommand(install.id, install.executable)
  return {
    ...escapeCmdSpawn(viaCmd, command.file, command.args),
    shell: viaCmd,
    env: childProcessEnv(viaCmd, inheritedEnv),
  }
}

/** Where the consultant's CLI is installed right now. */
function installedConsultant(id: CouncilAgentId): ConsultantInstall {
  if (id === 'pi') return { id, cli: getPiCli() }
  return { id, executable: detectAgents().find((agent) => agent.id === id)?.path ?? null }
}

/** Default spawn: run the consultant CLI, stream output, enforce timeout. */
export const defaultSpawnConsultant: SpawnConsultant = (id, prompt, cwd, timeoutMs, onChunk) =>
  new Promise<SpawnOutcome>((resolve) => {
    const launch = buildConsultantLaunch(installedConsultant(id), IS_WINDOWS, process.env)
    if ('error' in launch) {
      resolve({ ok: false, output: '', error: launch.error })
      return
    }
    const child = spawn(launch.file, launch.args, {
      cwd,
      env: launch.env,
      shell: launch.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Ignore EPIPE if the child exits before consuming stdin; write then close
    // so the CLI sees a complete prompt and does not block waiting for more.
    child.stdin?.on('error', () => {})
    child.stdin?.end(prompt)
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let stdout = ''
    let stderr = ''
    let settled = false

    // Both CLIs emit JSONL: Claude via --output-format stream-json, Codex via
    // --json. We parse each line into readable text — streaming live via onChunk
    // and accumulating the plan separately from activity/reasoning noise.
    const isClaude = id === 'claude'
    let lineBuffer = ''
    let planText = ''
    let claudeFinal: string | undefined

    const applyLine = (line: string): void => {
      if (isClaude) {
        const { delta, final } = parseClaudeStreamLine(line)
        if (delta) {
          planText += delta
          onChunk?.(delta)
        }
        if (typeof final === 'string') claudeFinal = final
      } else {
        // Pi streams thinking as token deltas (append raw); Codex emits whole
        // reasoning items (separate with a newline).
        const isPi = id === 'pi'
        const { plan, display } = isPi ? parsePiStreamLine(line) : parseCodexStreamLine(line)
        if (typeof plan === 'string') {
          planText += plan
          onChunk?.(plan)
        } else if (typeof display === 'string') {
          // Reasoning/activity: show live but keep it out of the final plan.
          onChunk?.(isPi ? display : display + '\n')
        }
      }
    }

    const consume = (text: string): void => {
      lineBuffer += text
      let nl: number
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        applyLine(lineBuffer.slice(0, nl))
        lineBuffer = lineBuffer.slice(nl + 1)
      }
    }

    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_TIMEOUT_MS)
      finish({ ok: false, output: planText, timedOut: true })
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      const text = outDecoder.write(d)
      stdout += text
      consume(text)
    })
    child.stderr?.on('data', (d: Buffer) => { stderr += errDecoder.write(d) })
    child.on('error', (err) => finish({ ok: false, output: stdout, error: err.message }))
    child.on('close', (code) => {
      if (lineBuffer) applyLine(lineBuffer)
      if (code === 0) {
        // Prefer the parsed plan; fall back to raw stdout if parsing yielded nothing.
        const output = (claudeFinal ?? planText) || stdout
        finish({ ok: true, output })
      } else {
        // Some CLIs (e.g. Claude on an auth failure) print the real reason to
        // stdout, not stderr. Surface stdout as the error when stderr is empty so
        // the consultant card shows something actionable instead of "exit code N".
        finish({ ok: false, output: stdout, error: stderr.trim() || stdout.trim() || `exit code ${code}` })
      }
    })
  })
