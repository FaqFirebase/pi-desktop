export interface AgentWorkTracker {
  /** Keyed per runtime, never per workspace, so a waiting runtime cannot hide a working sibling. */
  setRunningTurn(runtimeKey: string, running: boolean): void
  setBackgroundRuns(sourceKey: string, running: number): void
  /** Counts as work until `run` settles, also when it rejects. */
  runWhileWorking<T>(run: () => Promise<T>): Promise<T>
  isWorking(): boolean
}

/**
 * Whether any agent work runs: a runtime's turn, a background subagent run,
 * or a council run. `onChange` fires only when that answer changes.
 */
export function createAgentWorkTracker(onChange: (working: boolean) => void): AgentWorkTracker {
  const runningTurns = new Set<string>()
  const backgroundRuns = new Map<string, number>()
  let activeRuns = 0
  let working = false

  const isWorking = (): boolean => runningTurns.size > 0 || backgroundRuns.size > 0 || activeRuns > 0

  const update = (): void => {
    const next = isWorking()
    if (next === working) return
    working = next
    onChange(next)
  }

  return {
    isWorking,

    setRunningTurn(runtimeKey, running) {
      if (running) runningTurns.add(runtimeKey)
      else runningTurns.delete(runtimeKey)
      update()
    },

    setBackgroundRuns(sourceKey, running) {
      if (running > 0) backgroundRuns.set(sourceKey, running)
      else backgroundRuns.delete(sourceKey)
      update()
    },

    async runWhileWorking(run) {
      activeRuns += 1
      update()
      try {
        return await run()
      } finally {
        activeRuns -= 1
        update()
      }
    },
  }
}
