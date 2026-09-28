import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type {
  GitConveyorCommitOptions,
  GitConveyorPullRequestOptions,
} from '../../shared/ipc-contracts'
import { assertTrustedSender, isObject, isOptionalBoolean, isOptionalString, isString } from './validation'
import { commitAll, createPullRequest, getGitConveyorStatus, listLocalBranches, pushBranch, switchLocalBranch } from '../git-conveyor'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

function activeCwd(ctx: IpcContext): string {
  const cwd = ctx.workspaceManager.getActiveWorkspace()?.path
  if (!cwd) throw new Error(t('errors.workspace.noneActive'))
  return cwd
}

export function registerGitConveyorHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_STATUS, async (event) => {
    assertTrustedSender(event)
    return getGitConveyorStatus(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_LOCAL_BRANCHES, async (event) => {
    assertTrustedSender(event)
    return listLocalBranches(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_SWITCH_BRANCH, async (event, workspaceId: unknown, branch: unknown) => {
    assertTrustedSender(event)
    if (!isString(workspaceId) || !isString(branch)) throw new Error('workspaceId and branch must be strings')
    const workspace = ctx.workspaceManager.getActiveWorkspace()
    if (!workspace || workspace.id !== workspaceId) throw new Error(t('conveyor.errors.workspaceChanged'))
    const active = ctx.workspaceManager.getSessionRuntimes(workspaceId)
      .some((runtime) => runtime.activity === 'working' || runtime.activity === 'needs-approval')
    if (active) throw new Error(t('conveyor.branches.agentWorking'))
    const status = await switchLocalBranch(workspace.path, branch)
    if (ctx.workspaceManager.getActiveWorkspace()?.id === workspaceId) {
      ctx.broadcast(IPC_CHANNELS.EVENT_FILE_CHANGE, { changeType: 'change', relativePath: '.' })
    }
    return status
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_COMMIT, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (!isObject(input) || !isString(input.message)) throw new Error('Commit message must be a string')
    const options: GitConveyorCommitOptions = { message: input.message }
    return commitAll(activeCwd(ctx), options)
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_PUSH, async (event) => {
    assertTrustedSender(event)
    return pushBranch(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_CREATE_PR, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (
      !isObject(input) ||
      !isString(input.title) ||
      !isString(input.body) ||
      !isOptionalString(input.base) ||
      !isOptionalBoolean(input.draft)
    ) {
      throw new Error('Pull request title, body, optional base branch, and optional draft flag are required')
    }
    const options: GitConveyorPullRequestOptions = {
      title: input.title,
      body: input.body,
      ...(typeof input.base === 'string' ? { base: input.base } : {}),
      ...(typeof input.draft === 'boolean' ? { draft: input.draft } : {}),
    }
    return createPullRequest(activeCwd(ctx), options)
  })
}
