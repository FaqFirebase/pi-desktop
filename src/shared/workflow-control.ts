import type { WorkflowControlAction, WorkflowRunStatus } from './ipc-contracts'

/**
 * Control eligibility for a persisted workflow run — the single source of the
 * extension's authoritative matrix (pi-dynamic-workflows' workflow-control-tool
 * `allowedActions`): stop = running|paused, resume = paused|failed|pending.
 *
 * It lives in shared/ because BOTH sides need it and they must never drift:
 * the renderer decides which buttons are meaningful, and the main-process IPC
 * gate (ipc/workflow-handlers.ts) refuses to dispatch a doomed command. The
 * extension still enforces the same matrix at dispatch time.
 *
 * Every status outside the lists below — including the synthetic `unknown`
 * used for unrecognised persisted states — is never actionable.
 */

/** Abort (`stop`) is meaningful only while the run can still be stopped. */
export function canAbortRun(status: WorkflowRunStatus): boolean {
  return status === 'running' || status === 'paused'
}

/** Resume is meaningful only where the extension actually supports it. */
export function canResumeRun(status: WorkflowRunStatus): boolean {
  return status === 'paused' || status === 'failed' || status === 'pending'
}

/** The one gate for a control action, keyed by the action the caller wants. */
export function isWorkflowActionAllowed(
  action: WorkflowControlAction,
  status: WorkflowRunStatus
): boolean {
  return action === 'stop' ? canAbortRun(status) : canResumeRun(status)
}
