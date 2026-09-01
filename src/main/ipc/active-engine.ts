import type { AgentEngineKind } from '../../shared/ipc-contracts'
import { getConfiguredEngineKind } from '../pi-rpc-manager'
import type { WorkspaceManager } from '../workspace-manager'

/**
 * Engine the user is looking at right now: the active session's runtime
 * engine when one is live (a Pi-store session resumes under Pi and an OMP
 * session under OMP regardless of the configured default), else the
 * configured default. Every per-engine IPC decision (models file, skill
 * roots, plugin CLI) reads this one rule so the UI and the file it touches
 * never disagree.
 */
export function activeEngineKind(workspaceManager: WorkspaceManager): AgentEngineKind {
  return workspaceManager.getActivePiManager()?.getEngineKind() ?? getConfiguredEngineKind()
}
