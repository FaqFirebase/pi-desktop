import { ipcMain } from 'electron'
import { WorkspaceManager } from '../workspace-manager'
import type {
  CouncilRunResult,
  CouncilDetectResult,
  CouncilArbiterResult,
} from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { COUNCIL_AGENT_IDS, clampTimeoutSeconds } from '../../shared/council-config'
import type { CouncilAgentId, ConsensusMode, ConsultantResult } from '../../shared/council-config'
import { detectAgents } from '../agent-detection'
import { runConsultants, runArbiter, defaultSpawnConsultant, type ArbiterRequest } from '../council-manager'
import { access } from 'fs/promises'
import { isString, isObject } from './validation'
import type { IpcContext } from './context'

/**
 * Resolve the working directory for council runs: the active workspace, never
 * the renderer's input, so agents plan against the real project tree. Falls back
 * to the home directory if the workspace path is inaccessible.
 */
async function resolveCouncilCwd(workspaceManager: WorkspaceManager): Promise<string> {
  const activeWs = workspaceManager.getActiveWorkspace()
  if (!activeWs) throw new Error('No active workspace')
  try {
    await access(activeWs.path)
    return activeWs.path
  } catch {
    return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
  }
}

export function registerCouncilHandlers(ctx: IpcContext): void {
  const { workspaceManager, broadcast } = ctx

  ipcMain.handle(IPC_CHANNELS.COUNCIL_DETECT, async (): Promise<CouncilDetectResult> => {
    const agents = detectAgents().map((a) => ({ id: a.id, found: a.found }))
    return { agents }
  })

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_RUN_CONSULTANTS,
    async (_event, payload: unknown): Promise<CouncilRunResult> => {
      // Validate the payload before spawning any child processes.
      if (!isObject(payload)) throw new Error('Council run payload must be an object')
      if (!isString(payload.request) || payload.request.trim().length === 0) {
        throw new Error('Council run request must be a non-empty string')
      }
      if (
        !Array.isArray(payload.members) ||
        payload.members.length === 0 ||
        !payload.members.every((m): m is CouncilAgentId => COUNCIL_AGENT_IDS.includes(m as CouncilAgentId))
      ) {
        throw new Error('Council run members must be a non-empty list of known agents')
      }
      if (payload.consensusMode !== 'arbiter' && payload.consensusMode !== 'debate') {
        throw new Error('Council run consensusMode must be "arbiter" or "debate"')
      }
      const members = payload.members as CouncilAgentId[]
      const consensusMode = payload.consensusMode as ConsensusMode
      const timeoutSeconds = clampTimeoutSeconds(Number(payload.timeoutSeconds))

      // The working directory is the active workspace, never the renderer's
      // input — consultants must plan against the real project tree.
      const cwd = await resolveCouncilCwd(workspaceManager)

      const results = await runConsultants(
        { request: payload.request, members, cwd, timeoutSeconds, consensusMode },
        {
          spawnConsultant: defaultSpawnConsultant,
          onProgress: (id, chunk) => broadcast(IPC_CHANNELS.EVENT_COUNCIL_PROGRESS, { id, chunk }),
        },
      )
      return { results }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_ARBITER,
    async (_event, payload: unknown): Promise<CouncilArbiterResult> => {
      if (!isObject(payload)) throw new Error('Council arbiter payload must be an object')
      if (!isString(payload.request) || payload.request.trim().length === 0) {
        throw new Error('Council arbiter request must be a non-empty string')
      }
      const timeoutSeconds = clampTimeoutSeconds(Number(payload.timeoutSeconds))

      let input: ArbiterRequest
      if (payload.kind === 'merge') {
        if (!Array.isArray(payload.results)) {
          throw new Error('Council arbiter merge requires a results array')
        }
        input = {
          kind: 'merge',
          request: payload.request,
          results: payload.results as ConsultantResult[],
        }
      } else if (payload.kind === 'revise') {
        if (!isString(payload.plan) || payload.plan.trim().length === 0) {
          throw new Error('Council arbiter revise requires a non-empty plan')
        }
        if (!isString(payload.feedback) || payload.feedback.trim().length === 0) {
          throw new Error('Council arbiter revise requires non-empty feedback')
        }
        input = {
          kind: 'revise',
          request: payload.request,
          plan: payload.plan,
          feedback: payload.feedback,
        }
      } else {
        throw new Error('Council arbiter kind must be "merge" or "revise"')
      }

      const cwd = await resolveCouncilCwd(workspaceManager)
      const outcome = await runArbiter(input, cwd, timeoutSeconds, {
        spawnConsultant: defaultSpawnConsultant,
        onProgress: (chunk) => broadcast(IPC_CHANNELS.EVENT_COUNCIL_PROGRESS, { id: 'pi', chunk }),
      })
      if (!outcome.ok) {
        throw new Error(outcome.timedOut ? 'Arbiter timed out' : outcome.error ?? 'Arbiter failed')
      }
      return { plan: outcome.output.trim() }
    },
  )
}
