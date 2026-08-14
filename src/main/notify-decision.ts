/**
 * Pure decision for desktop notifications, mirroring tray-decision.ts: no
 * Electron imports so the matrix is unit-testable.
 */
export interface NotifyParams {
  /** The desktopNotifications setting. */
  enabled: boolean
  /** Whether the app window currently has OS focus. */
  windowFocused: boolean
  /** Workspace the event happened in (null when unknown). */
  eventWorkspaceId: string | null
  activeWorkspaceId: string | null
}

/**
 * Notify unless the user is already looking at the workspace in question: a
 * focused window suppresses events from the active workspace only, while an
 * unfocused window notifies for everything (the user is in another app).
 */
export function shouldNotify(params: NotifyParams): boolean {
  if (!params.enabled) return false
  if (params.eventWorkspaceId === null) return false
  if (params.windowFocused && params.eventWorkspaceId === params.activeWorkspaceId) return false
  return true
}
