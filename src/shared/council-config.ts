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

const MIN_TIMEOUT_SECONDS = 10
const MAX_TIMEOUT_SECONDS = 600

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
