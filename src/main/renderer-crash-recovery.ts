/** A second crash this soon after an automatic reload asks instead of reloading again. */
export const CRASH_RELOAD_WINDOW_MS = 60_000
/** The renderer exited on purpose (the window closed); not a crash. */
export const CLEAN_EXIT_REASON = 'clean-exit'

export type CrashRecoveryAction = 'ignore' | 'reload' | 'ask'

export function crashRecoveryAction(input: {
  reason: string
  isQuitting: boolean
  windowDestroyed: boolean
  now: number
  lastReloadAt: number | null
}): CrashRecoveryAction {
  if (input.isQuitting || input.windowDestroyed || input.reason === CLEAN_EXIT_REASON) return 'ignore'
  if (input.lastReloadAt === null || input.now - input.lastReloadAt >= CRASH_RELOAD_WINDOW_MS) return 'reload'
  return 'ask'
}
