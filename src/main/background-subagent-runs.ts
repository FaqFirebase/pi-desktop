import type { PiRpcEvent } from '../shared/ipc-contracts'
import {
  applyOmpLifecycle,
  applyOmpProgress,
  countRunningSubagentTasks,
  tasksFromPiAsyncWidget,
  PI_ASYNC_WIDGET_KEY,
  type SubagentTask,
} from '../shared/subagent-task'

export interface BackgroundSubagentRuns {
  /** Both return whether `runningCount()` changed. */
  handleEvent(event: PiRpcEvent): boolean
  /** Forget every run, for a process that stopped or crashed. */
  reset(): boolean
  runningCount(): number
}

/**
 * Subagent runs of one agent process that can outlive a turn: OMP subagents
 * and pi-subagents async runs. Foreground subagent tool calls are not counted
 * here, because they run inside a turn.
 */
export function createBackgroundSubagentRuns(): BackgroundSubagentRuns {
  let ompTasks: SubagentTask[] = []
  // Each async widget snapshot is the extension's full state, so it replaces
  // the last one: a run it no longer lists must stop counting.
  let asyncSnapshot: SubagentTask[] = []

  const runningCount = (): number =>
    countRunningSubagentTasks(ompTasks) + countRunningSubagentTasks(asyncSnapshot)

  const track = (change: () => void): boolean => {
    const before = runningCount()
    change()
    return runningCount() !== before
  }

  return {
    runningCount,

    handleEvent(event) {
      return track(() => {
        if (event.type === 'subagent_lifecycle') ompTasks = applyOmpLifecycle(ompTasks, event.payload)
        else if (event.type === 'subagent_progress') ompTasks = applyOmpProgress(ompTasks, event.payload)
        else if (event.type === 'extension_ui_request' && event.method === 'setWidget' && event.widgetKey === PI_ASYNC_WIDGET_KEY) {
          asyncSnapshot = tasksFromPiAsyncWidget(event.widgetLines) ?? []
        }
      })
    },

    reset() {
      return track(() => {
        ompTasks = []
        asyncSnapshot = []
      })
    },
  }
}
