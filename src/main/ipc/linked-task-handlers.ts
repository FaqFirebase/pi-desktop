import { ipcMain } from 'electron'
import { IPC_CHANNELS, WHOLE_WORKSPACE_CHANGE_PATH } from '../../shared/ipc-contracts'
import type { LinkedShipRequest, LinkedTaskMode, LinkedTaskOptions, RepoSetDraft, RepoSetMember } from '../../shared/ipc-contracts'
import { assertTrustedSender, isObject, isOptionalString, isOptionalStringArray, isString } from './validation'
import { loadAppSettings } from './settings'
import { startNewTabInBackground } from './workspace-handlers'
import { RepoSetStore, inspectRepoFolder } from '../repo-sets'
import { shipLinkedTask } from '../linked-ship'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

const LINKED_TASK_MODES: readonly LinkedTaskMode[] = ['isolated', 'inPlace']

function validateMember(value: unknown): RepoSetMember {
  if (!isObject(value) || !isString(value.name) || !isString(value.sourcePath) ||
      (value.role !== 'main' && value.role !== 'linked')) {
    throw new Error('Each repository needs a name, a sourcePath, and the role main or linked')
  }
  return { name: value.name, sourcePath: value.sourcePath, role: value.role }
}

function validateRepoSetDraft(value: unknown): RepoSetDraft {
  if (!isObject(value) || !isOptionalString(value.id) || !isString(value.name) || !Array.isArray(value.members)) {
    throw new Error('A repo set needs a name and a members array')
  }
  return { ...(isString(value.id) ? { id: value.id } : {}), name: value.name, members: value.members.map(validateMember) }
}

function validateLinkedTaskOptions(value: unknown): LinkedTaskOptions {
  if (!isObject(value) || !isString(value.setId) || !LINKED_TASK_MODES.includes(value.mode as LinkedTaskMode) ||
      !isOptionalString(value.name)) {
    throw new Error('A linked task needs a setId, the mode isolated or inPlace, and an optional name')
  }
  return { setId: value.setId, mode: value.mode as LinkedTaskMode, ...(isString(value.name) ? { name: value.name } : {}) }
}

function validateShipRequest(value: unknown): LinkedShipRequest {
  if (!isObject(value) || !isString(value.message) || !isString(value.title) || !isString(value.body) ||
      !isObject(value.newFiles) || !isOptionalStringArray(value.repos)) {
    throw new Error('Ship all needs a message, a title, a body, a newFiles map, and an optional repos array')
  }
  const newFiles: Record<string, string[]> = {}
  for (const [name, files] of Object.entries(value.newFiles)) {
    if (!Array.isArray(files) || !files.every(isString)) throw new Error('newFiles must map repository names to string arrays')
    newFiles[name] = files
  }
  return {
    message: value.message,
    title: value.title,
    body: value.body,
    newFiles,
    ...(value.repos ? { repos: value.repos } : {}),
  }
}

export function registerLinkedTaskHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx
  const repoSets = new RepoSetStore()

  ipcMain.handle(IPC_CHANNELS.REPO_SET_LIST, async (event) => {
    assertTrustedSender(event)
    return repoSets.list()
  })

  ipcMain.handle(IPC_CHANNELS.REPO_SET_SAVE, async (event, draft: unknown) => {
    assertTrustedSender(event)
    return repoSets.save(validateRepoSetDraft(draft))
  })

  ipcMain.handle(IPC_CHANNELS.REPO_SET_DELETE, async (event, id: unknown) => {
    assertTrustedSender(event)
    if (!isString(id)) throw new Error('id must be a string')
    await repoSets.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.REPO_SET_INSPECT_FOLDER, async (event, path: unknown) => {
    assertTrustedSender(event)
    if (!isString(path)) throw new Error('path must be a string')
    return inspectRepoFolder(path)
  })

  ipcMain.handle(IPC_CHANNELS.LINKED_TASK_CREATE, async (event, value: unknown) => {
    assertTrustedSender(event)
    const options = validateLinkedTaskOptions(value)
    const set = await repoSets.get(options.setId)
    const settings = await loadAppSettings(workspaceManager)
    const workspace = await workspaceManager.createLinkedTaskWorkspace(set, options)
    startNewTabInBackground(workspaceManager, workspace, settings)
    return workspace
  })

  ipcMain.handle(IPC_CHANNELS.LINKED_TASK_ADD_REPO, async (event, workspaceId: unknown, path: unknown) => {
    assertTrustedSender(event)
    if (!isString(workspaceId) || !isString(path)) throw new Error('workspaceId and path must be strings')
    return workspaceManager.addRepoToLinkedTask(workspaceId, path)
  })

  ipcMain.handle(IPC_CHANNELS.LINKED_TASK_FOCUS_REPO, async (event, workspaceId: unknown, name: unknown) => {
    assertTrustedSender(event)
    if (!isString(workspaceId) || !isString(name)) throw new Error('workspaceId and name must be strings')
    workspaceManager.focusLinkedRepo(workspaceId, name)
  })

  ipcMain.handle(IPC_CHANNELS.LINKED_TASK_STATUS, async (event, workspaceId: unknown) => {
    assertTrustedSender(event)
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    return workspaceManager.getLinkedTaskStatus(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.LINKED_TASK_SHIP, async (event, workspaceId: unknown, value: unknown) => {
    assertTrustedSender(event)
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    const request = validateShipRequest(value)
    const workspace = workspaceManager.getWorkspaces().find((item) => item.id === workspaceId)
    if (!workspace?.linkedTask) throw new Error(t('repoSets.errors.notLinkedTask'))
    // A commit taken while the agent still edits would ship half a change.
    const working = workspaceManager.getSessionRuntimes(workspaceId)
      .some((runtime) => runtime.activity === 'working' || runtime.activity === 'needs-approval')
    if (working) throw new Error(t('repoSets.ship.errors.agentWorking'))
    const result = await shipLinkedTask(workspace.linkedTask.repos, request)
    if (workspaceManager.getActiveWorkspaceId() === workspaceId) {
      ctx.broadcast(IPC_CHANNELS.EVENT_FILE_CHANGE, { changeType: 'change', relativePath: WHOLE_WORKSPACE_CHANGE_PATH })
    }
    return result
  })
}
