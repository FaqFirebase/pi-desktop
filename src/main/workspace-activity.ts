import type {
  PendingPromptCounts,
  PiProcessStatus,
  WorkspaceActivity,
  WorkspaceActivityMap,
  WorkspaceActivityState,
} from '../shared/ipc-contracts'

/**
 * Derives per-workspace background activity (working / needs-approval /
 * completed / failed) from every workspace's Pi lifecycle signals.
 *
 * The renderer's stream state deliberately follows only the ACTIVE workspace
 * (see pi-event-router.ts), so cross-workspace awareness must be computed
 * main-side and pushed as its own map — this module is that computation.
 *
 * Electron-free factory: all I/O goes through injected deps, so tests drive it
 * with plain calls and an injected clock.
 */

export type WorkspaceActivityNotification = {
  workspaceId: string
  kind: 'completed' | 'failed' | 'needs-approval'
}

export interface WorkspaceActivityTrackerDeps {
  getActiveWorkspaceId(): string | null
  now(): number
  /** Called with the full map after any derived state changes. */
  onChange(map: WorkspaceActivityMap): void
  /**
   * Called on the raw events (turn finished, process failed, prompt queued)
   * for EVERY workspace including the active one — the map suppresses
   * outcomes for the active workspace (its state is on screen), but a
   * notification decision also cares about window focus, which only the
   * caller can judge (see notify-decision.ts).
   */
  onNotify(notification: WorkspaceActivityNotification): void
}

export interface WorkspaceActivityTracker {
  handleAgentStart(workspaceId: string): void
  handleAgentEnd(workspaceId: string): void
  handleStatusChange(workspaceId: string, status: PiProcessStatus): void
  /**
   * The manager's 'exit' emission: the process died UNEXPECTEDLY after
   * reaching running (a deliberate stop() detaches listeners first and never
   * emits it). This — not the 'stopped' status both paths share — is the
   * failure signal, so quitting or stopping Pi mid-turn stays silent.
   */
  handleProcessExit(workspaceId: string): void
  handlePendingCounts(counts: PendingPromptCounts): void
  /** The user is now looking at this workspace — clear finished outcomes. */
  handleWorkspaceSeen(workspaceId: string): void
  handleWorkspaceRemoved(workspaceId: string): void
  getMap(): WorkspaceActivityMap
}

interface WorkspaceSignals {
  turnActive: boolean
  pendingCount: number
  outcome: 'completed' | 'failed' | null
  /**
   * The status hit 'stopped' while a turn was running. Kept because the
   * crash path emits status-change 'stopped' BEFORE 'exit', so by the time
   * handleProcessExit runs, turnActive has already been cleared.
   */
  stoppedMidTurn: boolean
}

function deriveState(signals: WorkspaceSignals): WorkspaceActivityState | null {
  if (signals.pendingCount > 0) return 'needs-approval'
  if (signals.turnActive) return 'working'
  return signals.outcome
}

export function createWorkspaceActivityTracker(
  deps: WorkspaceActivityTrackerDeps,
): WorkspaceActivityTracker {
  const signals = new Map<string, WorkspaceSignals>()
  // Last derived state per workspace, with the timestamp it was entered.
  const derived = new Map<string, WorkspaceActivity>()

  const signalsFor = (workspaceId: string): WorkspaceSignals => {
    let entry = signals.get(workspaceId)
    if (!entry) {
      entry = { turnActive: false, pendingCount: 0, outcome: null, stoppedMidTurn: false }
      signals.set(workspaceId, entry)
    }
    return entry
  }

  const buildMap = (): WorkspaceActivityMap => {
    const map: WorkspaceActivityMap = {}
    for (const [workspaceId, activity] of derived) {
      map[workspaceId] = { ...activity }
    }
    return map
  }

  // Recompute derived states and emit the map when anything actually changed.
  const recompute = (): void => {
    let changed = false
    for (const [workspaceId, entry] of signals) {
      const nextState = deriveState(entry)
      const previous = derived.get(workspaceId) ?? null
      if (nextState === (previous?.state ?? null)) continue
      changed = true
      if (nextState === null) {
        derived.delete(workspaceId)
        continue
      }
      derived.set(workspaceId, { state: nextState, since: deps.now() })
    }
    if (changed) deps.onChange(buildMap())
  }

  return {
    handleAgentStart(workspaceId) {
      const entry = signalsFor(workspaceId)
      entry.turnActive = true
      entry.outcome = null
      entry.stoppedMidTurn = false
      recompute()
    },

    handleAgentEnd(workspaceId) {
      const entry = signalsFor(workspaceId)
      const wasTurnActive = entry.turnActive
      entry.turnActive = false
      entry.stoppedMidTurn = false
      // Finishing while watched needs no map marker; finishing in the
      // background stays visible until the user looks at that workspace. The
      // notification fires either way — focus, not activity, decides there.
      entry.outcome = deps.getActiveWorkspaceId() === workspaceId ? null : 'completed'
      if (wasTurnActive) deps.onNotify({ workspaceId, kind: 'completed' })
      recompute()
    },

    handleStatusChange(workspaceId, status) {
      const entry = signalsFor(workspaceId)
      const isActive = deps.getActiveWorkspaceId() === workspaceId
      if (status === 'error') {
        entry.turnActive = false
        entry.stoppedMidTurn = false
        entry.outcome = isActive ? null : 'failed'
        deps.onNotify({ workspaceId, kind: 'failed' })
      } else if (status === 'stopped') {
        // 'stopped' alone is neutral — deliberate stops (user stop, quit,
        // folder change) land here too. Only a following 'exit' emission
        // (unexpected death) turns a mid-turn stop into a failure.
        entry.stoppedMidTurn = entry.turnActive
        entry.turnActive = false
      } else if (status === 'running') {
        // Fresh (re)start — previous outcomes no longer describe this process.
        entry.turnActive = false
        entry.stoppedMidTurn = false
        entry.outcome = null
      }
      recompute()
    },

    handleProcessExit(workspaceId) {
      const entry = signalsFor(workspaceId)
      if (entry.stoppedMidTurn || entry.turnActive) {
        entry.outcome = deps.getActiveWorkspaceId() === workspaceId ? null : 'failed'
        deps.onNotify({ workspaceId, kind: 'failed' })
      }
      entry.stoppedMidTurn = false
      entry.turnActive = false
      recompute()
    },

    handlePendingCounts(counts) {
      for (const workspaceId of Object.keys(counts)) {
        const entry = signalsFor(workspaceId)
        // A workspace newly waiting on an answer is notification-worthy; a
        // count moving 2 -> 3 while already waiting is not.
        if (entry.pendingCount === 0 && counts[workspaceId] > 0) {
          deps.onNotify({ workspaceId, kind: 'needs-approval' })
        }
        entry.pendingCount = counts[workspaceId]
      }
      // Zero entries are omitted from the broadcast shape.
      for (const [workspaceId, entry] of signals) {
        if (!(workspaceId in counts)) entry.pendingCount = 0
      }
      recompute()
    },

    handleWorkspaceSeen(workspaceId) {
      const entry = signals.get(workspaceId)
      if (!entry) return
      entry.outcome = null
      recompute()
    },

    handleWorkspaceRemoved(workspaceId) {
      const hadState = derived.delete(workspaceId)
      signals.delete(workspaceId)
      if (hadState) deps.onChange(buildMap())
    },

    getMap: buildMap,
  }
}
