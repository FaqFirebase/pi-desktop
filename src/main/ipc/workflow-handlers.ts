import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type WorkflowControlAction, type WorkflowControlResult } from '../../shared/ipc-contracts'
import { getWorkflowRun, listWorkflowRuns, resolveWorkflowWorkspaces, setWorkflowPersistence } from '../workflow-monitor'
import { assertTrustedSender, isString } from './validation'
import type { PiRpcManager } from '../pi-rpc-manager'
import type { IpcContext } from './context'

/**
 * The one resolved workspace projection shared by list, getRun and control:
 * registered workspaces keep their ids (healed in memory when their persisted
 * path is a lossy phantom), plus read-only `workflow-<key>` projections for
 * every discovered project that is not registered.
 */
async function workflowWorkspaces(ctx: IpcContext) {
  return resolveWorkflowWorkspaces(ctx.workspaceManager.getWorkspaces())
}

async function findWorkspace(ctx: IpcContext, workspaceId: string) {
  const workspaces = await workflowWorkspaces(ctx)
  return workspaces.find((workspace) => workspace.id === workspaceId) ?? null
}

// The extension's authoritative control matrix (workflow-control-tool.ts
// `allowedActions`): stop = running|paused, resume = paused|failed|pending.
// The extension enforces it again at dispatch time; this gate only decides
// which buttons are meaningful and avoids dispatching doomed commands.
function actionAllowedForStatus(action: WorkflowControlAction, status: string): boolean {
  if (action === 'stop') return status === 'running' || status === 'paused'
  if (action === 'resume') return status === 'paused' || status === 'failed' || status === 'pending'
  return false
}

/** Probe the workspace's Pi for the `/workflows` extension command. */
async function hasWorkflowsExtension(pi: PiRpcManager): Promise<boolean> {
  const command = pi.getEngineKind() === 'omp' ? 'get_available_commands' : 'get_commands'
  const response = await pi.sendCommand({ type: command }) as
    | { success?: boolean; data?: { commands?: Array<{ name?: unknown; source?: unknown }> } }
    | null
  if (!response?.success || !Array.isArray(response.data?.commands)) return false
  return response.data.commands.some(
    (candidate) => candidate?.name === 'workflows' && candidate?.source === 'extension'
  )
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message)
}

export function registerWorkflowHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_LIST, async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event)
    // The launch-cwd projection must be included here too, not only in
    // findWorkspace: a run from the current (possibly unregistered) project
    // has to appear in the navigator list as well as be openable by id.
    return listWorkflowRuns(await workflowWorkspaces(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_GET_RUN, async (event: IpcMainInvokeEvent, workspaceId: unknown, runId: unknown) => {
    assertTrustedSender(event)
    if (!isString(workspaceId) || !isString(runId)) throw new Error('workspaceId and runId must be strings')
    const workspace = await findWorkspace(ctx, workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    const run = await getWorkflowRun(workspace, runId)
    if (!run) throw new Error('Workflow run not found')
    return run
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_CONTROL,
    async (event: IpcMainInvokeEvent, workspaceId: unknown, runId: unknown, action: unknown): Promise<WorkflowControlResult> => {
      assertTrustedSender(event)
      if (!isString(workspaceId) || !isString(runId) || (action !== 'stop' && action !== 'resume')) {
        throw new Error('workspaceId, runId and action are required')
      }
      const fail = (reason: WorkflowControlResult['reason']): WorkflowControlResult => ({ action, runId, ok: false, reason })

      // Gate on the persisted status first (never fake a transition locally).
      const workspace = await findWorkspace(ctx, workspaceId)
      if (!workspace) return fail('no-pi')
      const run = await getWorkflowRun(workspace, runId)
      if (!run) return fail('status-not-permitted')
      if (!actionAllowedForStatus(action, run.status)) return fail('status-not-permitted')

      // Route to the run's OWN session runtime, never the active one. A
      // missing session identity is unsafe to guess, so fail closed.
      if (!run.sessionId) return fail('no-pi')
      const pi = ctx.workspaceManager.getPiManagerForSession(workspaceId, run.sessionId)
      if (!pi) return fail('no-pi')

      // The extension command is what executes the control; only dispatch when
      // it is actually registered in that Pi process. Without this probe an
      // unloaded extension would fall through to a real LLM prompt turn.
      try {
        if (!(await hasWorkflowsExtension(pi))) return fail('extension-missing')
      } catch {
        return fail('extension-missing')
      }

      try {
        // Extension commands execute immediately in Pi, even during streaming —
        // no LLM turn is started for a registered command.
        await pi.sendCommand({ type: 'prompt', message: `/workflows ${action} ${runId}` })
        return { action, runId, ok: true, dispatched: true }
      } catch (error) {
        return fail(isTimeoutError(error) ? 'timeout' : 'dispatch-failed')
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_SET_PERSISTENCE, async (event: IpcMainInvokeEvent, enabled: unknown) => {
    assertTrustedSender(event)
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    await setWorkflowPersistence(enabled)
  })
}
