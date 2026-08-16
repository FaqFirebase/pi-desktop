import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isString } from './validation'
import { validateStartOptions, applyPermissionModeToStartOptions } from './pi-start-options'
import { loadAppSettings } from './settings'
import type { IpcContext } from './context'

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
    await workspaceManager.removeWorkspace(workspaceId)
    // Notes scoped to the removed workspace fall back to global so they survive.
    await notesManager.reassignToGlobal(workspaceId)
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
      applyPermissionModeToStartOptions({ cwd: workspace.path, ...opts }, settings)
    )
    const pi = workspaceManager.getPiManager(workspaceId)
    return pi?.getStatus() ?? { status: 'stopped', pid: null, error: null }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_STOP_PI, async (_event, workspaceId: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    workspaceManager.stopPiForWorkspace(workspaceId)
    return { status: 'stopped', pid: null, error: null }
  })
}
