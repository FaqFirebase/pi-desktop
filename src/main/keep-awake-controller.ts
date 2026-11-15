import type { KeepAwakeMode, KeepAwakeStatus } from '../shared/keep-awake'
import type { KeepAwakeCoordinator, SleepBlockState } from './keep-awake-coordinator'

/**
 * How long "While agents work" keeps holding after the last work ends. It
 * covers the gap between back-to-back turns (a queued message, a next step),
 * so the sleep block is not released and taken again for each one.
 */
export const KEEP_AWAKE_RELEASE_DELAY_MS = 10_000

export function shouldHoldAwake(mode: KeepAwakeMode, working: boolean): boolean {
  return mode === 'always' || (mode === 'while-working' && working)
}

export function deriveKeepAwakeStatus(mode: KeepAwakeMode, state: SleepBlockState): KeepAwakeStatus {
  if (mode === 'off') return 'off'
  if (state === 'unsupported') return 'unsupported'
  return state === 'held' ? 'holding' : 'waiting-for-work'
}

export interface KeepAwakeControllerDeps {
  coordinator: Pick<KeepAwakeCoordinator, 'apply' | 'getState'>
  releaseDelayMs: number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
  onStatusChange(status: KeepAwakeStatus): void
}

export interface KeepAwakeController {
  setMode(mode: KeepAwakeMode): Promise<KeepAwakeStatus>
  setWorking(working: boolean): Promise<KeepAwakeStatus>
  /** Compute the status again after the sleep block changed by itself (a lost lock). */
  refreshStatus(): void
  getStatus(): KeepAwakeStatus
}

/**
 * Turns the mode and "is agent work running" into hold and release calls.
 * A mode change applies at once; the end of work releases only after
 * `releaseDelayMs`, and work that starts again inside it keeps the hold.
 *
 * Electron-free: the coordinator and the timer are injected.
 */
export function createKeepAwakeController(deps: KeepAwakeControllerDeps): KeepAwakeController {
  let mode: KeepAwakeMode = 'off'
  let working = false
  let status: KeepAwakeStatus = 'off'
  let requestedHold = false
  let releaseTimer: unknown = null

  const refreshStatus = (): void => {
    const next = deriveKeepAwakeStatus(mode, deps.coordinator.getState())
    if (next === status) return
    status = next
    deps.onStatusChange(next)
  }

  const cancelReleaseTimer = (): void => {
    if (releaseTimer === null) return
    deps.clearTimer(releaseTimer)
    releaseTimer = null
  }

  const apply = async (hold: boolean): Promise<KeepAwakeStatus> => {
    requestedHold = hold
    await deps.coordinator.apply(hold)
    refreshStatus()
    return status
  }

  const releaseAfterDelay = (): void => {
    releaseTimer = null
    if (mode === 'while-working' && !working) void apply(false)
  }

  return {
    refreshStatus,
    getStatus: () => status,

    setMode(next) {
      mode = next
      cancelReleaseTimer()
      return apply(shouldHoldAwake(mode, working))
    },

    async setWorking(next) {
      working = next
      if (mode !== 'while-working') return status
      if (working) {
        cancelReleaseTimer()
        // A hold that is already asked for (and did not fail) needs no second acquire.
        if (requestedHold && deps.coordinator.getState() !== 'unsupported') return status
        return apply(true)
      }
      if (releaseTimer === null) releaseTimer = deps.setTimer(releaseAfterDelay, deps.releaseDelayMs)
      return status
    },
  }
}
