import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { parseTranscriptRef, type SubagentListResult, type SubagentTranscriptResult } from '../../shared/subagent-task'
import { fetchSubagentTranscript, listSubagents } from '../subagent-transcripts'
import { assertTrustedSender } from './validation'
import type { IpcContext } from './context'

export function registerSubagentHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.SUBAGENT_LIST, async (event: IpcMainInvokeEvent): Promise<SubagentListResult> => {
    assertTrustedSender(event)
    const pi = ctx.workspaceManager.getActivePiManager()
    return pi ? listSubagents(pi) : { supported: false, tasks: [] }
  })

  ipcMain.handle(
    IPC_CHANNELS.SUBAGENT_GET_TRANSCRIPT,
    async (event: IpcMainInvokeEvent, ref: unknown, cursor: unknown): Promise<SubagentTranscriptResult> => {
      assertTrustedSender(event)
      const parsed = parseTranscriptRef(ref)
      if (!parsed || typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
        throw new Error('A transcript ref and a non-negative integer cursor are required')
      }
      const pi = ctx.workspaceManager.getActivePiManager()
      return pi ? fetchSubagentTranscript(pi, parsed, cursor) : { kind: 'error', code: 'unavailable' }
    }
  )
}
