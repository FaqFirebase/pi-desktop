import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isString, isObject, isOptionalString } from './validation'
import { validateStartOptions, applyResumePreference, applyPermissionModeToStartOptions } from './pi-start-options'
import { loadAppSettings } from './settings'
import type { WorkspaceTabOptions } from '../../shared/ipc-contracts'
import { getSessionsRoot } from '../pi-paths'
import { isPathWithin } from '../path-authorization'
import { existsSync } from 'fs'
import type { IpcContext } from './context'
import { appLog } from '../app-log'

function validateWorkspaceTabOptions(value: unknown): WorkspaceTabOptions {
  if (value === undefined || value === null) return {}
  if (!isObject(value)) throw new Error('Tab options must be an object')
  if (!isOptionalString(value.name)) throw new Error('tab name must be a string')
  if (!isOptionalString(value.sourceWorkspaceId)) throw new Error('sourceWorkspaceId must be a string')
  if (!isOptionalString(value.forkSessionPath)) throw new Error('forkSessionPath must be a string')

  return {
    ...(isString(value.name) ? { name: value.name } : {}),
    ...(isString(value.sourceWorkspaceId) ? { sourceWorkspaceId: value.sourceWorkspaceId } : {}),
    ...(isString(value.forkSessionPath) ? { forkSessionPath: value.forkSessionPath } : {}),
  }
}

export function registerWorkspaceHandlers(ctx: IpcContext): void {
  const { workspaceManager, notesManager } = ctx

  // ─── Workspace Management ───────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async () => {
    return workspaceManager.getWorkspaces()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, async (_event, name: unknown, path: unknown) => {
    if (!isString(name)) throw new Error('name must be a string')
    if (!isString(path)) throw new Error('path must be a string')
    return workspaceManager.createWorkspace(name, path)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REMOVE, async (_event, workspaceId: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    const result = await workspaceManager.removeWorkspace(workspaceId)
    // Notes scoped to the removed workspace fall back to global so they survive.
    await notesManager.reassignToGlobal(workspaceId)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_RENAME, async (_event, workspaceId: unknown, name: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    if (!isString(name)) throw new Error('name must be a string')
    await workspaceManager.renameWorkspace(workspaceId, name)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CHANGE_PATH, async (_event, workspaceId: unknown, newPath: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    if (!isString(newPath)) throw new Error('newPath must be a string')
    await workspaceManager.changeWorkspacePath(workspaceId, newPath)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_PATH_EXISTS, async (): Promise<boolean> => {
    return workspaceManager.activeWorkspacePathExists()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SET_ACTIVE, async (_event, workspaceId: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    return workspaceManager.setActiveWorkspace(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_ACTIVE, async () => {
    return workspaceManager.getActiveWorkspace()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_START_PI, async (_event, workspaceId: unknown, options?: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    const opts = validateStartOptions(options)
    const settings = await loadAppSettings(workspaceManager)
    const workspace = workspaceManager.getWorkspaces().find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    await workspaceManager.startPiForWorkspace(
      workspaceId,
      applyPermissionModeToStartOptions(
        applyResumePreference({ cwd: workspace.path, ...opts }, settings),
        settings
      )
    )
    const pi = workspaceManager.getPiManager(workspaceId)
    return pi?.getStatus() ?? { status: 'stopped', pid: null, error: null }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_STOP_PI, async (_event, workspaceId: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    workspaceManager.stopPiForWorkspace(workspaceId)
    return { status: 'stopped', pid: null, error: null }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE_TAB, async (_event, value: unknown) => {
    const options = validateWorkspaceTabOptions(value)
    if (options.forkSessionPath) {
      if (!isPathWithin(getSessionsRoot(), options.forkSessionPath) || !existsSync(options.forkSessionPath)) {
        throw new Error('forkSessionPath must point to an existing Pi session file')
      }
    }

    const settings = await loadAppSettings(workspaceManager)
    const workspace = await workspaceManager.createWorktreeWorkspace(options)
    // Return the new project tab immediately. Its session runtime starts in the
    // background so the tab/file contents are usable before Pi is ready.
    void workspaceManager.startPiForWorkspace(
      workspace.id,
      applyPermissionModeToStartOptions(
        applyResumePreference(
          {
            cwd: workspace.path,
            provider: settings.defaultProvider ?? undefined,
            model: settings.defaultModel ?? undefined,
            forkSessionPath: options.forkSessionPath,
          },
          settings
        ),
        settings
      )
    ).catch((error) => appLog.warn('workspaces', 'Background worktree Pi start failed', error))
    return workspace
  })
}
