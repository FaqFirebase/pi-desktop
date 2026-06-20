/** Consultant agents the council can include. PI is always the builder/arbiter. */
export type CouncilAgentId = 'claude' | 'codex'

export const COUNCIL_AGENT_IDS: CouncilAgentId[] = ['claude', 'codex']

/** How PI reconciles consultant plans into one. */
export type ConsensusMode = 'arbiter' | 'debate'

export interface CouncilConfig {
  /** Master switch; off by default. */
  enabled: boolean
  /** Per-agent checkbox state (user intent, independent of detection). */
  members: Record<CouncilAgentId, boolean>
  consensusMode: ConsensusMode
  /** Per-consultant time budget in seconds. */
  timeoutSeconds: number
}

export const MIN_TIMEOUT_SECONDS = 10
export const MAX_TIMEOUT_SECONDS = 600

/** Clamp an arbitrary number into the valid per-member timeout range. */
export function clampTimeoutSeconds(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_COUNCIL_CONFIG.timeoutSeconds
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.round(raw)))
}

export const DEFAULT_COUNCIL_CONFIG: CouncilConfig = {
  enabled: false,
  members: { claude: true, codex: true },
  consensusMode: 'arbiter',
  timeoutSeconds: 90,
}

const VALID_CONSENSUS_MODES: ConsensusMode[] = ['arbiter', 'debate']

/** Validate a council config. Returns human-readable errors; empty means valid. */
export function validateCouncilConfig(config: CouncilConfig): string[] {
  const errors: string[] = []
  const t = config.timeoutSeconds
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    errors.push('Council timeout must be a finite number')
  } else if (t < MIN_TIMEOUT_SECONDS || t > MAX_TIMEOUT_SECONDS) {
    errors.push(`Council timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`)
  }
  if (!VALID_CONSENSUS_MODES.includes(config.consensusMode)) {
    errors.push(`Unknown consensus mode: ${String(config.consensusMode)}`)
  }
  return errors
}

export type ConsultantStatus = 'contributed' | 'timed-out' | 'errored'

export interface ConsultantResult {
  id: CouncilAgentId
  status: ConsultantStatus
  plan?: string
  error?: string
}

export interface MemberResolution {
  /** True when the feature is enabled and >= 1 consultant is checked+detected. */
  canRun: boolean
  /** Consultant ids that are both checked and detected. */
  active: CouncilAgentId[]
  /** Why the run cannot proceed, when canRun is false. */
  reason?: string
}

/**
 * Resolve which consultants will run. PI is always the builder/arbiter and is
 * never in this list. Requires at least one other agent to reach consensus.
 */
export function resolveActiveMembers(
  config: CouncilConfig,
  detected: Record<CouncilAgentId, boolean>,
): MemberResolution {
  const active = COUNCIL_AGENT_IDS.filter((id) => config.members[id] && detected[id])
  if (!config.enabled) {
    return { canRun: false, active, reason: 'Council planning is disabled in Settings.' }
  }
  if (active.length < 1) {
    return {
      canRun: false,
      active,
      reason: 'Council needs at least one other agent. Install or enable Claude or Codex, or turn the council off.',
    }
  }
  return { canRun: true, active }
}

/** True when at least one consultant produced a usable plan. */
export function hasQuorum(results: ConsultantResult[]): boolean {
  return results.some((r) => r.status === 'contributed')
}

const AGENT_LABELS: Record<CouncilAgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

/** Prompt sent to each consultant: produce a plan, change nothing. */
export function buildConsultantPrompt(request: string): string {
  return [
    'You are a planning consultant. Read the project if helpful, but DO NOT modify, edit, write, or create any files.',
    'Produce a concise, concrete implementation plan for the request below: key files, structure, and steps.',
    'Output ONLY the plan.',
    '',
    'REQUEST:',
    request,
  ].join('\n')
}

/** Prompt sent to PI (arbiter) to merge contributed consultant plans into one. */
export function buildConsensusPrompt(request: string, results: ConsultantResult[]): string {
  const sections = results
    .filter((r) => r.status === 'contributed' && r.plan)
    .map((r) => `### Plan from ${AGENT_LABELS[r.id]}\n${r.plan}`)
    .join('\n\n')
  return [
    'You are the arbiter and the builder. Several agents proposed plans for the request below.',
    'Synthesize them into ONE consensus implementation plan you endorse, noting any tradeoffs you resolved.',
    'Output ONLY the consensus plan. DO NOT implement, build, or write any files yet — wait for approval.',
    '',
    'REQUEST:',
    request,
    '',
    'PROPOSED PLANS:',
    sections,
  ].join('\n')
}

/** Prompt for the optional debate round: revise own plan given the others'. */
export function buildDebatePrompt(
  request: string,
  _self: CouncilAgentId,
  others: ConsultantResult[],
): string {
  const sections = others
    .filter((r) => r.status === 'contributed' && r.plan)
    .map((r) => `### Plan from ${AGENT_LABELS[r.id]}\n${r.plan}`)
    .join('\n\n')
  return [
    "Here are other agents' plans for the same request. Critique them and revise YOUR plan accordingly.",
    'DO NOT modify, edit, or write any files. Output ONLY your revised plan.',
    '',
    'REQUEST:',
    request,
    '',
    'OTHER PLANS:',
    sections,
  ].join('\n')
}

/** Spawn argv for a consultant in read-only mode. Flags verified per CLI. */
export function buildConsultantCommand(
  id: CouncilAgentId,
  executable: string,
  prompt: string,
): { file: string; args: string[] } {
  switch (id) {
    case 'claude':
      return { file: executable, args: ['-p', prompt, '--permission-mode', 'plan'] }
    case 'codex':
      return { file: executable, args: ['exec', '--sandbox', 'read-only', prompt] }
  }
}
