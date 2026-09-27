import { app, ipcMain } from 'electron'
import { realpath } from 'fs/promises'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type {
  GitConveyorCommitOptions,
  GitConveyorPullRequestOptions,
} from '../../shared/ipc-contracts'
import { assertTrustedSender, isObject, isOptionalBoolean, isOptionalString, isOptionalStringArray, isString } from './validation'
import { commitAll, createPullRequest, getGitConveyorStatus, pushBranch, readCommitDiff } from '../git-conveyor'
import { CommitMessageService } from '../commit-message-service'
import { generateCommitMessage, sessionCommitMessageModel, type CommitMessageModel } from '../commit-message-generator'
import { activeEngineKind } from './active-engine'
import { loadAppSettings } from './settings'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

function activeCwd(ctx: IpcContext): string {
  const cwd = ctx.workspaceManager.getActiveWorkspace()?.path
  if (!cwd) throw new Error(t('errors.workspace.noneActive'))
  return cwd
}

/** The active session's model when it is running, else the configured default. */
async function commitMessageModel(ctx: IpcContext): Promise<CommitMessageModel> {
  const manager = ctx.workspaceManager.getActivePiManager()
  const session = manager?.getStatus().status === 'running' ? await sessionCommitMessageModel(manager) : null
  if (session) return session
  const settings = await loadAppSettings(ctx.workspaceManager)
  return {
    engine: activeEngineKind(ctx.workspaceManager),
    selection: settings.defaultProvider && settings.defaultModel
      ? { provider: settings.defaultProvider, model: settings.defaultModel } : null,
  }
}

export function registerGitConveyorHandlers(ctx: IpcContext): void {
  const messages = new CommitMessageService({ resolvePath: realpath, readDiff: readCommitDiff })
  app.on('will-quit', () => messages.dispose())

  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT_MESSAGE_GENERATE, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (!isObject(input) || typeof input.force !== 'boolean' || !isOptionalStringArray(input.paths)) {
      throw new Error('force must be a boolean and paths an optional string array')
    }
    return messages.suggest(activeCwd(ctx), async (diff, signal) =>
      generateCommitMessage(diff, await commitMessageModel(ctx), signal), input.force, input.paths)
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_STATUS, async (event) => {
    assertTrustedSender(event)
    return getGitConveyorStatus(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_COMMIT, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (!isObject(input) || !isString(input.message) || !isOptionalStringArray(input.paths)) {
      throw new Error('Commit message must be a string and paths an optional string array')
    }
    const options: GitConveyorCommitOptions = {
      message: input.message,
      ...(input.paths ? { paths: input.paths } : {}),
    }
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
