import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { parseTranscriptRef, type SubagentListResult, type SubagentTranscriptResult } from '../../shared/subagent-task'
import { activeManagerForRuntime, fetchSubagentTranscript, listSubagents } from '../subagent-transcripts'
import { assertTrustedSender, isString } from './validation'
import type { IpcContext } from './context'

export function registerSubagentHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.SUBAGENT_LIST, async (event: IpcMainInvokeEvent, runtimeId: unknown): Promise<SubagentListResult> => {
    assertTrustedSender(event)
    if (!isString(runtimeId)) throw new Error('runtimeId must be a string')
    const pi = activeManagerForRuntime(ctx.workspaceManager, runtimeId)
    return pi ? listSubagents(pi) : { supported: false, tasks: [] }
  })

  ipcMain.handle(
    IPC_CHANNELS.SUBAGENT_GET_TRANSCRIPT,
    async (event: IpcMainInvokeEvent, runtimeId: unknown, ref: unknown, cursor: unknown): Promise<SubagentTranscriptResult> => {
      assertTrustedSender(event)
      const parsed = parseTranscriptRef(ref)
      if (!isString(runtimeId) || !parsed || typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
        throw new Error('A runtime id, a transcript ref and a non-negative integer cursor are required')
      }
      const pi = activeManagerForRuntime(ctx.workspaceManager, runtimeId)
      return pi ? fetchSubagentTranscript(pi, parsed, cursor) : { kind: 'error', code: 'unavailable' }
    }
  )
}
