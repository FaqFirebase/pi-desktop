import type { WorkflowAgentStatus, WorkflowRunStatus, WorkflowRunSummary } from '../../../shared/ipc-contracts'

/**
 * Resolve the Pi session identifier used to scope workflow runs.
 *
 * Persisted runs carry `run.sessionId` = Pi's header UUID (e.g.
 * `01a01a28-f010-7b29-8312-21ba523d9edf`), so a session-scoped filter must
 * compare UUIDs. When a session row's header is unreadable, `piSessionId`
 * is missing; the session filename stem (`<timestamp>_<uuid>`) is still a
 * valid source because its suffix IS the UUID. The raw stem — the registry
 * key used by tags/archive — never matches a run's `sessionId`.
 *
 * Returns null when no UUID can be derived (defensive; session files are
 * always named `<timestamp>_<uuid>.jsonl`).
 */
export function resolveRunSessionId(
  piSessionId: string | undefined,
  sessionId: string
): string | null {
  if (piSessionId) return piSessionId
  const underscore = sessionId.indexOf('_')
  if (underscore <= 0 || underscore >= sessionId.length - 1) return null
  return sessionId.slice(underscore + 1)
}

/**
 * The single filter used by the workflow navigator. Global mode (`null`)
 * returns every run; session mode matches `run.sessionId` exactly, so a
 * scoped panel can never show another session's runs.
 */
export function filterRunsBySession(
  runs: readonly WorkflowRunSummary[],
  sessionId: string | null
): WorkflowRunSummary[] {
  return sessionId ? runs.filter((run) => run.sessionId === sessionId) : [...runs]
}

/**
 * The workspace-scope filter for the sidebar's Activity → Workflows entry.
 * Global mode (`null`) returns every run; workspace mode matches
 * `run.workspaceId` exactly, so a scoped panel can never show another
 * project's runs. Applied AFTER the session filter (session scope wins).
 */
export function filterRunsByWorkspace(
  runs: readonly WorkflowRunSummary[],
  workspaceId: string | null
): WorkflowRunSummary[] {
  return workspaceId ? runs.filter((run) => run.workspaceId === workspaceId) : [...runs]
}

// ─── Terminal presentation ───────────────────────────────────────────────────
// Persisted runs can freeze in-flight agents and currentPhase when a run is
// aborted/failed mid-flight. These helpers are presentation-only: the
// persisted agent statuses are never rewritten, they just stop looking active.

/** Run-level statuses that are finished; nothing below them is still spinning. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'completed',
  'failed',
  'aborted',
])

export function isTerminalRun(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

/**
 * Agents that should render as actively working. On a terminal run a stale
 * persisted `running` agent is frozen, not active — count it as idle.
 */
export function runActiveAgentCount(
  agents: ReadonlyArray<{ status: WorkflowAgentStatus }>,
  runStatus: WorkflowRunStatus
): number {
  if (isTerminalRun(runStatus)) return 0
  return agents.filter((agent) => agent.status === 'running').length
}

// ─── Control eligibility ─────────────────────────────────────────────────────
// One implementation, in shared/, so the main-process dispatch gate and these
// renderer call sites cannot encode different rules. Re-exported here because
// the workflow components already consume it from this module.

export { canAbortRun, canResumeRun, isWorkflowActionAllowed } from '../../../shared/workflow-control'
