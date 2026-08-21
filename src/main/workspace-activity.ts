import type {
  PendingPromptCounts,
  PiProcessStatus,
  WorkspaceActivity,
  WorkspaceActivityMap,
  WorkspaceActivityState,
} from '../shared/ipc-contracts'

/**
 * Derives aggregate workspace activity from independent session runtimes.
 *
 * The renderer's stream state follows only the active runtime, while this
 * tracker must preserve every background runtime's turn independently. A
 * workspace-level boolean loses that information as soon as a sibling runtime
 * starts or stops.
 */

export type WorkspaceActivityNotification = {
  workspaceId: string
  kind: 'completed' | 'failed' | 'needs-approval'
  runtimeId?: string
  sessionPath?: string
}

type RuntimeTarget = { runtimeId?: string; sessionPath?: string }

export interface WorkspaceActivityTrackerDeps {
  getActiveWorkspaceId(): string | null
  now(): number
  onChange(map: WorkspaceActivityMap): void
  onNotify(notification: WorkspaceActivityNotification): void
}

export interface WorkspaceActivityTracker {
  handleAgentStart(workspaceId: string, target?: RuntimeTarget): void
  handleAgentEnd(workspaceId: string, target?: RuntimeTarget): void
  handleStatusChange(workspaceId: string, status: PiProcessStatus, target?: RuntimeTarget): void
  handleProcessExit(workspaceId: string, target?: RuntimeTarget): void
  handlePendingCounts(counts: PendingPromptCounts): void
  handleWorkspaceSeen(workspaceId: string): void
  handleWorkspaceRemoved(workspaceId: string): void
  getMap(): WorkspaceActivityMap
}

interface RuntimeSignals {
  workspaceId: string
  turnActive: boolean
  outcome: 'completed' | 'failed' | null
  outcomeAt: number
  /**
   * The status hit 'stopped' while a turn was running. A subsequent exit
   * distinguishes an unexpected crash from deliberate stop().
   */
  stoppedMidTurn: boolean
}

function runtimeKey(workspaceId: string, target?: RuntimeTarget): string {
  return target?.runtimeId ?? target?.sessionPath ?? workspaceId
}

export function createWorkspaceActivityTracker(
  deps: WorkspaceActivityTrackerDeps,
): WorkspaceActivityTracker {
  const signals = new Map<string, RuntimeSignals>()
  const pendingByWorkspace = new Map<string, number>()
  const derived = new Map<string, WorkspaceActivity>()

  const signalsFor = (workspaceId: string, target?: RuntimeTarget): RuntimeSignals => {
    const key = runtimeKey(workspaceId, target)
    let entry = signals.get(key)
    if (!entry && target) {
      const fallback = signals.get(workspaceId)
      if (fallback && fallback.workspaceId === workspaceId) {
        signals.delete(workspaceId)
        signals.set(key, fallback)
        entry = fallback
      }
    }
    if (!entry) {
      entry = {
        workspaceId,
        turnActive: false,
        outcome: null,
        outcomeAt: 0,
        stoppedMidTurn: false,
      }
      signals.set(key, entry)
    }
    return entry
  }

  const buildMap = (): WorkspaceActivityMap => {
    const map: WorkspaceActivityMap = {}
    for (const [workspaceId, activity] of derived) map[workspaceId] = { ...activity }
    return map
  }

  const recompute = (): void => {
    const workspaceIds = new Set<string>([
      ...[...signals.values()].map((entry) => entry.workspaceId),
      ...pendingByWorkspace.keys(),
      ...derived.keys(),
    ])
    let changed = false

    for (const workspaceId of workspaceIds) {
      const workspaceSignals = [...signals.values()].filter((entry) => entry.workspaceId === workspaceId)
      const pending = pendingByWorkspace.get(workspaceId) ?? 0
      const latestOutcome = workspaceSignals
        .filter((entry) => entry.outcome !== null)
        .sort((left, right) => right.outcomeAt - left.outcomeAt)[0]?.outcome ?? null
      const nextState: WorkspaceActivityState | null =
        pending > 0
          ? 'needs-approval'
          : workspaceSignals.some((entry) => entry.turnActive)
            ? 'working'
            : latestOutcome
      const previous = derived.get(workspaceId) ?? null
      if (nextState === (previous?.state ?? null)) continue
      changed = true
      if (nextState === null) derived.delete(workspaceId)
      else derived.set(workspaceId, { state: nextState, since: deps.now() })
    }
    if (changed) deps.onChange(buildMap())
  }

  return {
    handleAgentStart(workspaceId, target) {
      const entry = signalsFor(workspaceId, target)
      entry.turnActive = true
      entry.outcome = null
      entry.outcomeAt = 0
      entry.stoppedMidTurn = false
      recompute()
    },

    handleAgentEnd(workspaceId, target) {
      const entry = signalsFor(workspaceId, target)
      const wasTurnActive = entry.turnActive
      entry.turnActive = false
      entry.stoppedMidTurn = false
      entry.outcome = deps.getActiveWorkspaceId() === workspaceId ? null : 'completed'
      entry.outcomeAt = deps.now()
      if (wasTurnActive) deps.onNotify({ workspaceId, kind: 'completed', ...target })
      recompute()
    },

    handleStatusChange(workspaceId, status, target) {
      const entry = signalsFor(workspaceId, target)
      const isActive = deps.getActiveWorkspaceId() === workspaceId
      if (status === 'error') {
        entry.turnActive = false
        entry.stoppedMidTurn = false
        entry.outcome = isActive ? null : 'failed'
        entry.outcomeAt = deps.now()
        deps.onNotify({ workspaceId, kind: 'failed', ...target })
      } else if (status === 'stopped') {
        entry.stoppedMidTurn = entry.turnActive
        entry.turnActive = false
      } else if (status === 'running') {
        entry.turnActive = false
        entry.stoppedMidTurn = false
        entry.outcome = null
        entry.outcomeAt = 0
      }
      recompute()
    },

    handleProcessExit(workspaceId, target) {
      const entry = signalsFor(workspaceId, target)
      if (entry.stoppedMidTurn || entry.turnActive) {
        entry.outcome = deps.getActiveWorkspaceId() === workspaceId ? null : 'failed'
        entry.outcomeAt = deps.now()
        deps.onNotify({ workspaceId, kind: 'failed', ...target })
      }
      entry.stoppedMidTurn = false
      entry.turnActive = false
      recompute()
    },

    handlePendingCounts(counts) {
      for (const workspaceId of Object.keys(counts)) {
        const previous = pendingByWorkspace.get(workspaceId) ?? 0
        const next = counts[workspaceId]
        if (previous === 0 && next > 0) {
          deps.onNotify({ workspaceId, kind: 'needs-approval' })
        }
        pendingByWorkspace.set(workspaceId, next)
      }
      for (const workspaceId of pendingByWorkspace.keys()) {
        if (!(workspaceId in counts)) pendingByWorkspace.delete(workspaceId)
      }
      recompute()
    },

    handleWorkspaceSeen(workspaceId) {
      for (const entry of signals.values()) {
        if (entry.workspaceId !== workspaceId) continue
        entry.outcome = null
        entry.outcomeAt = 0
      }
      recompute()
    },

    handleWorkspaceRemoved(workspaceId) {
      for (const [key, entry] of signals) {
        if (entry.workspaceId === workspaceId) signals.delete(key)
      }
      pendingByWorkspace.delete(workspaceId)
      if (derived.delete(workspaceId)) deps.onChange(buildMap())
    },

    getMap: buildMap,
  }
}
