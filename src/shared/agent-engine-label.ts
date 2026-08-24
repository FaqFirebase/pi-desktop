import type { AgentEngineKind } from './ipc-contracts'

/**
 * Display names for the two agent CLIs.
 *
 * Shared by both processes because several surfaces name the running agent —
 * the status bar, the empty chat state, the session row tags, and the
 * permission prompt the agent itself raises — and they must agree. Wherever
 * the UI says "Pi" about the agent rather than about the app, it has to say
 * "OMP" when OMP is the engine.
 */
const AGENT_ENGINE_LABELS: Record<AgentEngineKind, string> = {
  pi: 'Pi',
  omp: 'OMP',
}

/**
 * Fallback for a caller that must render something. Used where the engine is
 * not yet known but a name is unavoidable, such as a permission prompt raised
 * before the GUI told the extension which engine it belongs to.
 */
export const DEFAULT_AGENT_ENGINE_LABEL = AGENT_ENGINE_LABELS.pi

/**
 * The display name for an engine, or null when the engine is unknown. Callers
 * that must render something choose their own fallback; callers that tag rows
 * show nothing rather than guess, because a wrong tag would name the wrong CLI.
 */
export function agentEngineLabel(engine: AgentEngineKind | null | undefined): string | null {
  return engine ? AGENT_ENGINE_LABELS[engine] : null
}
