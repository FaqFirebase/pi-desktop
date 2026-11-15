import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { PiProcessStatus, PiRpcEvent } from '../../shared/ipc-contracts'
import { agentWork, getKeepAwakeStatus, onKeepAwakeStatusChange } from '../keep-awake-service'
import { createRuntimeTurnState } from '../runtime-turn-state'
import { createBackgroundSubagentRuns } from '../background-subagent-runs'
import type { IpcContext } from './context'

/** Statuses after which a process holds no subagent runs. */
const ENDED_STATUSES: ReadonlySet<PiProcessStatus> = new Set(['stopped', 'error'])

let nextManagerNumber = 0

export function registerKeepAwakeHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_KEEP_AWAKE_STATUS, (event) => {
    ctx.assertMainSender(event)
    return getKeepAwakeStatus()
  })

  onKeepAwakeStatusChange((status) => ctx.broadcast(IPC_CHANNELS.EVENT_KEEP_AWAKE_STATUS, status))

  // Work is tracked per agent process, quick chat included. The workspace
  // activity map is not read: it shows one state per workspace, so a runtime
  // that waits on the user would hide a working sibling.
  ctx.workspaceManager.onPiManager((manager) => {
    nextManagerNumber += 1
    const key = `pi-manager-${nextManagerNumber}`
    const turns = createRuntimeTurnState()
    const runs = createBackgroundSubagentRuns()
    const reportTurn = (changed: boolean): void => {
      if (changed) agentWork.setRunningTurn(key, turns.isRunningTurn())
    }
    const reportRuns = (changed: boolean): void => {
      if (changed) agentWork.setBackgroundRuns(key, runs.runningCount())
    }

    manager.on('event', (event: PiRpcEvent) => {
      reportTurn(turns.handleEvent(event))
      reportRuns(runs.handleEvent(event))
    })
    manager.on('extension-ui-response', (id: string) => reportTurn(turns.handleUiResponse(id)))
    manager.on('status-change', (status: PiProcessStatus) => {
      reportTurn(turns.handleStatus(status))
      if (ENDED_STATUSES.has(status)) reportRuns(runs.reset())
    })
    manager.on('exit', () => {
      reportTurn(turns.handleExit())
      reportRuns(runs.reset())
    })
  })
}
