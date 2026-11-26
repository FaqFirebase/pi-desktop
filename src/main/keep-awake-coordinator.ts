import type { KeepAwake } from './keep-awake'
import type { SystemInhibitor } from './keep-awake-system-inhibitor'

/**
 * Whether sleep is blocked now. `unsupported` means the last hold found no
 * layer that can block sleep on this system; it stays after a release, so a
 * status shown while no hold is wanted still tells the user the truth.
 */
export type SleepBlockState = 'released' | 'held' | 'unsupported'

export interface KeepAwakeCoordinatorDeps {
  platform: NodeJS.Platform
  /** Electron's blocker: the native API on macOS and Windows, a desktop D-Bus service on Linux. */
  desktopBlocker: KeepAwake
  /** The systemd-logind lock, used on Linux when the desktop has no sleep service. */
  systemInhibitor: SystemInhibitor
  /**
   * Linux only. Electron's blocker does nothing, and reports no error, when
   * the desktop has no sleep service, so its presence must be checked here.
   */
  hasDesktopSleepService(): Promise<boolean>
}

export interface KeepAwakeCoordinator {
  apply(hold: boolean): Promise<SleepBlockState>
  getState(): SleepBlockState
  handleSystemInhibitorLost(): void
}

/**
 * Picks the layer that can keep this system awake. The desktop blocker is
 * preferred because it leaves a manual Sleep command working; the system
 * inhibitor is the fallback for Linux desktops without a power manager.
 */
export function createKeepAwakeCoordinator(deps: KeepAwakeCoordinatorDeps): KeepAwakeCoordinator {
  let state: SleepBlockState = 'released'
  // Calls can arrive faster than a lock is taken; running them in order makes the last one win.
  let queue: Promise<unknown> = Promise.resolve()

  const hold = async (): Promise<SleepBlockState> => {
    deps.desktopBlocker.apply(true)
    if (deps.platform !== 'linux') return 'held'
    if (await deps.hasDesktopSleepService()) {
      deps.systemInhibitor.release()
      return 'held'
    }
    return (await deps.systemInhibitor.acquire()) ? 'held' : 'unsupported'
  }

  const release = (): SleepBlockState => {
    deps.desktopBlocker.apply(false)
    deps.systemInhibitor.release()
    return state === 'unsupported' ? 'unsupported' : 'released'
  }

  return {
    getState: () => state,

    apply(shouldHold) {
      const run = queue.then(async () => {
        state = shouldHold ? await hold() : release()
        return state
      })
      queue = run.catch(() => undefined)
      return run
    },

    handleSystemInhibitorLost() {
      if (state === 'held') state = 'unsupported'
    },
  }
}
