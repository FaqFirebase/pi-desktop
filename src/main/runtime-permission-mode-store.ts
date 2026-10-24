import type { PermissionMode } from '../shared/ipc-contracts'

/**
 * The permission mode each runtime last started with, keyed by runtimeId.
 *
 * Recorded at `WorkspaceManager.startSessionRuntime` — the one point every
 * start path converges on (the popup's submit-driven start, the main window's
 * new-session and restart paths, and re-activating an evicted tab) — so the
 * badge reflects the mode the running process actually received, not the mode
 * some particular caller happened to have in hand.
 */
const runtimePermissionModes = new Map<string, PermissionMode>()

/** The permission mode a runtime last started with, or null when it never started. */
export function getRuntimePermissionMode(runtimeId: string): PermissionMode | null {
  return runtimePermissionModes.get(runtimeId) ?? null
}

/** Record the mode a runtime is starting with right now. */
export function recordRuntimePermissionMode(runtimeId: string, mode: PermissionMode | undefined): void {
  if (mode === undefined) return
  runtimePermissionModes.set(runtimeId, mode)
}

/** Drop a closed runtime's recorded start mode. */
export function forgetRuntimePermissionMode(runtimeId: string): void {
  runtimePermissionModes.delete(runtimeId)
}
