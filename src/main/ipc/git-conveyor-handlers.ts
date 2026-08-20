import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type {
  GitConveyorCommitOptions,
  GitConveyorPullRequestOptions,
} from '../../shared/ipc-contracts'
import { isObject, isOptionalBoolean, isString } from './validation'
import { commitAll, createPullRequest, getGitConveyorStatus, pushBranch } from '../git-conveyor'
import type { IpcContext } from './context'

function activeCwd(ctx: IpcContext): string {
  const cwd = ctx.workspaceManager.getActiveWorkspace()?.path
  if (!cwd) throw new Error('No active workspace')
  return cwd
}

export function registerGitConveyorHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_STATUS, async () => getGitConveyorStatus(activeCwd(ctx)))

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_COMMIT, async (_event, input: unknown) => {
    if (!isObject(input) || !isString(input.message)) throw new Error('Commit message must be a string')
    const options: GitConveyorCommitOptions = { message: input.message }
    return commitAll(activeCwd(ctx), options)
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_PUSH, async () => pushBranch(activeCwd(ctx)))

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_CREATE_PR, async (_event, input: unknown) => {
    if (!isObject(input) || !isString(input.title) || !isString(input.body) || !isOptionalBoolean(input.draft)) {
      throw new Error('Pull request title, body, and optional draft flag are required')
    }
    const options: GitConveyorPullRequestOptions = {
      title: input.title,
      body: input.body,
      ...(typeof input.draft === 'boolean' ? { draft: input.draft } : {}),
    }
    return createPullRequest(activeCwd(ctx), options)
  })
}
