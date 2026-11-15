/**
 * Keeps the system active while the screen may still turn off. The other
 * Electron type, 'prevent-display-sleep', would also hold the screen on.
 */
export const KEEP_AWAKE_BLOCKER_TYPE = 'prevent-app-suspension'

/** The part of Electron's `powerSaveBlocker` this module needs. */
export interface PowerBlocker {
  start(type: typeof KEEP_AWAKE_BLOCKER_TYPE): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface KeepAwake {
  /** Match the blocker to the setting. Returns whether a blocker is active. */
  apply(enabled: boolean): boolean
  isActive(): boolean
}

/**
 * Electron-free factory: the blocker is injected, so the on/off logic runs
 * under node:test with a fake. It holds at most one blocker, however often
 * the setting is saved.
 */
export function createKeepAwake(blocker: PowerBlocker): KeepAwake {
  let blockerId: number | null = null

  const isActive = (): boolean => blockerId !== null && blocker.isStarted(blockerId)

  return {
    isActive,
    apply(enabled) {
      if (enabled) {
        if (!isActive()) blockerId = blocker.start(KEEP_AWAKE_BLOCKER_TYPE)
        return true
      }
      if (isActive()) blocker.stop(blockerId as number)
      blockerId = null
      return false
    },
  }
}
