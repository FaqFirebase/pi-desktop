import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type { CouncilAgentId, ConsensusMode, ConsultantResult } from '../shared/council-config'
import {
  buildConsultantPrompt,
  buildDebatePrompt,
  buildConsultantCommand,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  parsePiStreamLine,
} from '../shared/council-config'
import { detectAgents } from './agent-detection'

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
  if (!outcome.ok) return { id, status: 'errored', error: outcome.error ?? 'unknown error' }
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

/** Default spawn: run the consultant CLI, stream output, enforce timeout. */
export const defaultSpawnConsultant: SpawnConsultant = (id, prompt, cwd, timeoutMs, onChunk) =>
  new Promise<SpawnOutcome>((resolve) => {
    const { file, args } = buildConsultantCommand(id, resolveExecutable(id), prompt)
    // stdin is closed ('ignore'): consultant CLIs take the prompt as an
    // argument, but if stdin is left open as an empty pipe they block waiting
    // for input (Claude warns "no stdin data received"; Codex reads stdin and
    // hangs until the timeout). Closing it makes them use the prompt arg.
    const child = spawn(file, args, {
      cwd,
      shell: IS_WINDOWS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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

// Resolve the executable path from agent detection; falls back to the bare id.
function resolveExecutable(id: CouncilAgentId): string {
  const found = detectAgents().find((a) => a.id === id)
  return found?.path ?? id
}
