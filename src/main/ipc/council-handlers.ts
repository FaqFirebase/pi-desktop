import { ipcMain } from 'electron'
import { homedir } from 'os'
import { WorkspaceManager } from '../workspace-manager'
import type {
  CouncilRunResult,
  CouncilDetectResult,
  CouncilArbiterResult,
  CouncilProgressEvent,
} from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { COUNCIL_AGENT_IDS, clampTimeoutSeconds } from '../../shared/council-config'
import type { CouncilAgentId, ConsensusMode, ConsultantResult } from '../../shared/council-config'
import { detectAgents } from '../agent-detection'
import { runConsultants, runArbiter, defaultSpawnConsultant, CouncilRuns, type ArbiterRequest, type SpawnOutcome } from '../council-manager'
import { agentWork } from '../keep-awake-service'
import { access } from 'fs/promises'
import { isString, isObject } from './validation'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

/**
 * Resolve the working directory for a council run: the registered workspace
 * the run started in, looked up by id, never a path from the renderer, so
 * agents plan against that project's tree even after the user switched to
 * another workspace. Falls back to the home directory if the workspace path
 * is inaccessible.
 */
async function resolveCouncilCwd(workspaceManager: WorkspaceManager, workspaceId: unknown): Promise<string> {
  if (!isString(workspaceId)) throw new Error('Council payload workspaceId must be a string')
  const workspace = workspaceManager.getWorkspaces().find((item) => item.id === workspaceId)
  if (!workspace) throw new Error(t('errors.workspace.notFound', { workspaceId }))
  try {
    await access(workspace.path)
    return workspace.path
  } catch {
    return homedir()
  }
}

/** The renderer's id of the run a council request belongs to. */
function councilRunId(payload: Record<string, unknown>): string {
  if (!isString(payload.runId) || payload.runId.length === 0) throw new Error('Council payload runId must be a non-empty string')
  return payload.runId
}

export function registerCouncilHandlers(ctx: IpcContext): void {
  const { workspaceManager, broadcast } = ctx
  const councilRuns = new CouncilRuns()
  const broadcastProgress = (runId: string, id: CouncilAgentId, chunk: string): void => {
    const event: CouncilProgressEvent = { runId, id, chunk }
    broadcast(IPC_CHANNELS.EVENT_COUNCIL_PROGRESS, event)
  }

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
      const runId = councilRunId(payload)
      const request = payload.request
      const members = payload.members as CouncilAgentId[]
      const consensusMode = payload.consensusMode as ConsensusMode
      const timeoutSeconds = clampTimeoutSeconds(Number(payload.timeoutSeconds))

      // Begin before the first await, so a cancel sent right after this
      // request finds the run.
      const step = councilRuns.begin(runId)
      try {
        // The working directory is the run's workspace, never a renderer path —
        // consultants must plan against the real project tree.
        const cwd = await resolveCouncilCwd(workspaceManager, payload.workspaceId)
        const results = await agentWork.runWhileWorking(() => runConsultants(
          { request, members, cwd, timeoutSeconds, consensusMode },
          {
            spawnConsultant: defaultSpawnConsultant,
            onProgress: (id, chunk) => broadcastProgress(runId, id, chunk),
            signal: step.signal,
          },
        ))
        return { results }
      } finally {
        step.end()
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_ARBITER,
    async (_event, payload: unknown): Promise<CouncilArbiterResult> => {
      if (!isObject(payload)) throw new Error('Council arbiter payload must be an object')
      if (!isString(payload.request) || payload.request.trim().length === 0) {
        throw new Error('Council arbiter request must be a non-empty string')
      }
      const runId = councilRunId(payload)
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

      const step = councilRuns.begin(runId)
      let outcome: SpawnOutcome
      try {
        const cwd = await resolveCouncilCwd(workspaceManager, payload.workspaceId)
        outcome = await agentWork.runWhileWorking(() => runArbiter(input, cwd, timeoutSeconds, {
          spawnConsultant: defaultSpawnConsultant,
          onProgress: (chunk) => broadcastProgress(runId, 'pi', chunk),
          signal: step.signal,
        }))
      } finally {
        step.end()
      }
      if (!outcome.ok) {
        throw new Error(outcome.timedOut ? t('errors.council.arbiterTimedOut') : outcome.error ?? t('errors.council.arbiterFailed'))
      }
      return { plan: outcome.output.trim() }
    },
  )

  ipcMain.handle(IPC_CHANNELS.COUNCIL_CANCEL, (event, payload: unknown): void => {
    ctx.assertMainSender(event)
    if (!isObject(payload)) throw new Error('Council cancel payload must be an object')
    councilRuns.cancel(councilRunId(payload))
  })
}
