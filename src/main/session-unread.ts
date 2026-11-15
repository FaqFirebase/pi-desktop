import { sessionIdFromPath } from './session-paths'
import type { SessionRuntimeInfo } from '../shared/ipc-contracts'
import type { SessionTimestampMap, SessionTimestampStore } from './session-timestamp-store'
import type { WorkspaceActivityNotification } from './workspace-activity'

/**
 * Unread sessions: a session is unread when an agent turn in it ended
 * (completed, failed or stopped) while it was not on screen. On screen means
 * the main view shows it AND the main window has focus. The renderer reports
 * the shown session; main knows the focus.
 *
 * The state lives here, in memory and in this file of the GUI data dir, so it
 * survives a restart: { "<sessionId>": <markedAtEpochMs> }.
 */
export const UNREAD_SESSIONS_FILE_NAME = 'unread-sessions.json'

/** Notification kinds that end a turn. A stopped turn ends with agent_end, reported as completed. */
const TURN_END_KINDS: ReadonlySet<WorkspaceActivityNotification['kind']> = new Set(['completed', 'failed'])

export interface SessionUnreadDeps {
  store: Pick<SessionTimestampStore, 'add' | 'remove' | 'getAll'>
  isMainWindowFocused(): boolean
  onChange(map: SessionTimestampMap): void
}

export interface SessionUnreadTracker {
  handleActivityNotification(notification: WorkspaceActivityNotification): Promise<void>
  /** A runtime snapshot: a turn end waiting for this runtime's file is marked once the file is known. */
  handleRuntimeSession(runtime: Pick<SessionRuntimeInfo, 'runtimeId' | 'sessionPath' | 'closed'>): Promise<void>
  setVisibleSession(sessionPath: string | null): Promise<void>
  handleMainWindowFocus(): Promise<void>
  forget(sessionId: string): Promise<void>
  getAll(): Promise<SessionTimestampMap>
}

export function createSessionUnreadTracker(deps: SessionUnreadDeps): SessionUnreadTracker {
  const { store } = deps
  let visibleSessionId: string | null = null
  // Runtimes whose turn ended before they reported their session file: a new
  // OMP session reports its file later than its first turn's end.
  const turnEndsAwaitingFile = new Set<string>()

  const isOnScreen = (sessionId: string): boolean =>
    sessionId === visibleSessionId && deps.isMainWindowFocused()

  const announce = async (changed: boolean): Promise<void> => {
    if (changed) deps.onChange(await store.getAll())
  }

  const markUnlessOnScreen = async (sessionPath: string): Promise<void> => {
    const sessionId = sessionIdFromPath(sessionPath)
    if (isOnScreen(sessionId)) return
    await announce(await store.add(sessionId))
  }

  const clearVisibleIfOnScreen = async (): Promise<void> => {
    if (visibleSessionId !== null && isOnScreen(visibleSessionId)) {
      await announce(await store.remove(visibleSessionId))
    }
  }

  return {
    async handleActivityNotification(notification) {
      if (!TURN_END_KINDS.has(notification.kind)) return
      if (notification.sessionPath) await markUnlessOnScreen(notification.sessionPath)
      else if (notification.runtimeId) turnEndsAwaitingFile.add(notification.runtimeId)
    },

    async handleRuntimeSession(runtime) {
      if (runtime.closed) {
        turnEndsAwaitingFile.delete(runtime.runtimeId)
        return
      }
      if (!runtime.sessionPath || !turnEndsAwaitingFile.delete(runtime.runtimeId)) return
      await markUnlessOnScreen(runtime.sessionPath)
    },

    async setVisibleSession(sessionPath) {
      visibleSessionId = sessionPath === null ? null : sessionIdFromPath(sessionPath)
      await clearVisibleIfOnScreen()
    },

    handleMainWindowFocus: clearVisibleIfOnScreen,

    async forget(sessionId) {
      await announce(await store.remove(sessionId))
    },

    getAll: () => store.getAll(),
  }
}
