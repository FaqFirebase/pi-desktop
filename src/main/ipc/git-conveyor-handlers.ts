import { app, ipcMain } from 'electron'
import { realpath } from 'fs/promises'
import { IPC_CHANNELS, WHOLE_WORKSPACE_CHANGE_PATH } from '../../shared/ipc-contracts'
import type {
  GitBranchSwitchResult,
  GitConveyorCommitOptions,
  GitConveyorPullRequestOptions,
  GitConveyorStatus,
} from '../../shared/ipc-contracts'
import {
  assertTrustedSender, isObject, isOptionalBoolean, isOptionalString, isOptionalStringArray, isString,
} from './validation'
import {
  GitSwitchRefusal, commitAll, createLocalBranch, createPullRequest, getGitConveyorStatus, listLocalBranches, pushBranch,
  readCommitDiff, switchLocalBranch,
} from '../git-conveyor'
import { CommitMessageService } from '../commit-message-service'
import { generateCommitMessage, sessionCommitMessageModel, type CommitMessageModel } from '../commit-message-generator'
import { activeEngineKind } from './active-engine'
import { loadAppSettings } from './settings'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

/** The repository the git panel shows: in a linked task, the focused one. */
function activeCwd(ctx: IpcContext): string {
  const cwd = ctx.workspaceManager.getActivePanelRoot()
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

/**
 * Run a branch change on the workspace the renderer asked for, then tell every
 * view of it that the worktree changed. An expected refusal goes back as a
 * result: Electron logs every rejected handler with a stack trace.
 */
async function changeBranch(
  ctx: IpcContext, workspaceId: string, change: (cwd: string) => Promise<GitConveyorStatus>,
): Promise<GitBranchSwitchResult> {
  try {
    const workspace = ctx.workspaceManager.getActiveWorkspace()
    if (!workspace || workspace.id !== workspaceId) throw new GitSwitchRefusal(t('conveyor.errors.workspaceChanged'))
    const status = await change(activeCwd(ctx))
    if (ctx.workspaceManager.getActiveWorkspace()?.id === workspaceId) {
      ctx.broadcast(IPC_CHANNELS.EVENT_FILE_CHANGE, { changeType: 'change', relativePath: WHOLE_WORKSPACE_CHANGE_PATH })
    }
    return { ok: true, status }
  } catch (err) {
    if (err instanceof GitSwitchRefusal) return { ok: false, error: err.message }
    throw err
  }
}

export function registerGitConveyorHandlers(ctx: IpcContext): void {
  const messages = new CommitMessageService({ resolvePath: realpath, readDiff: readCommitDiff })
  app.on('will-quit', () => messages.dispose())

  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT_MESSAGE_GENERATE, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (!isObject(input) || typeof input.force !== 'boolean' || !isOptionalStringArray(input.paths) ||
        !isOptionalStringArray(input.newFiles) || (input.newFiles && !input.paths)) {
      throw new Error('force must be a boolean, paths an optional string array, and newFiles a string array with paths')
    }
    return messages.suggest(activeCwd(ctx), async (diff, signal) =>
      generateCommitMessage(diff, await commitMessageModel(ctx), signal), input.force, input.paths, input.newFiles)
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_STATUS, async (event) => {
    assertTrustedSender(event)
    return getGitConveyorStatus(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_LOCAL_BRANCHES, async (event) => {
    assertTrustedSender(event)
    return listLocalBranches(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_SWITCH_BRANCH, async (event, workspaceId: unknown, branch: unknown): Promise<GitBranchSwitchResult> => {
    assertTrustedSender(event)
    if (!isString(workspaceId) || !isString(branch)) throw new Error('workspaceId and branch must be strings')
    return changeBranch(ctx, workspaceId, async (cwd) => {
      const active = ctx.workspaceManager.getSessionRuntimes(workspaceId)
        .some((runtime) => runtime.activity === 'working' || runtime.activity === 'needs-approval')
      if (active) throw new GitSwitchRefusal(t('conveyor.branches.agentWorking'))
      return switchLocalBranch(cwd, branch)
    })
  })

  // A new branch starts at HEAD and keeps the worktree as it is, so a running
  // agent is not stopped by it and uncommitted changes simply move along.
  ipcMain.handle(IPC_CHANNELS.GIT_CREATE_BRANCH, async (event, workspaceId: unknown, name: unknown): Promise<GitBranchSwitchResult> => {
    assertTrustedSender(event)
    if (!isString(workspaceId) || !isString(name)) throw new Error('workspaceId and name must be strings')
    return changeBranch(ctx, workspaceId, (cwd) => createLocalBranch(cwd, name))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_COMMIT, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (!isObject(input) || !isString(input.message) || !isOptionalStringArray(input.paths) ||
        !isOptionalStringArray(input.newFiles) || (input.newFiles && !input.paths)) {
      throw new Error('Commit message must be a string, paths an optional string array, and newFiles a string array with paths')
    }
    const options: GitConveyorCommitOptions = {
      message: input.message,
      ...(input.paths ? { paths: input.paths } : {}),
      ...(input.newFiles ? { newFiles: input.newFiles } : {}),
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
