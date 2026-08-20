import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { access } from 'fs/promises'
import { isString, isObject } from './validation'
import { validateStartOptions, applyResumePreference, applyPermissionModeToStartOptions } from './pi-start-options'
import { loadAppSettings } from './settings'
import type { IpcContext } from './context'
import { detectPiInstallations } from '../pi-rpc-manager'

export function registerPiHandlers(ctx: IpcContext): void {
  const { workspaceManager, getActivePi } = ctx

  // ─── Pi Process Lifecycle ───────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PI_START, async (_event, options?: unknown) => {
    const opts = validateStartOptions(options)
    const settings = await loadAppSettings(workspaceManager)
    const activeWs = workspaceManager.getActiveWorkspace()
    if (!activeWs) throw new Error('No active workspace')

    // Validate cwd exists; fall back to home directory if not
    let cwd = activeWs.path
    try {
      await access(cwd)
    } catch {
      cwd = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
    }

    // Prefer explicit start options, else last model chosen in the GUI.
    const withDefaults = {
      ...opts,
      cwd,
      provider: opts.provider ?? settings.defaultProvider ?? undefined,
      model: opts.model ?? settings.defaultModel ?? undefined,
    }
    await workspaceManager.startPiForWorkspace(
      activeWs.id,
      applyPermissionModeToStartOptions(applyResumePreference(withDefaults, settings), settings)
    )
    const pi = workspaceManager.getPiManager(activeWs.id)
    if (!pi) throw new Error('Failed to create Pi manager')

    return pi.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.PI_STOP, async () => {
    const activeWs = workspaceManager.getActiveWorkspace()
    if (activeWs) {
      workspaceManager.stopPiForWorkspace(activeWs.id)
    }
    return { status: 'stopped', pid: null, error: null }
  })

  ipcMain.handle(IPC_CHANNELS.PI_RESTART, async (_event, options?: unknown) => {
    const opts = validateStartOptions(options)
    const settings = await loadAppSettings(workspaceManager)
    const activeWs = workspaceManager.getActiveWorkspace()
    if (!activeWs) throw new Error('No active workspace')

    const pi = workspaceManager.getPiManager(activeWs.id)
    if (!pi) throw new Error('No Pi manager for workspace')

    pi.stop()
    return pi.start(
      applyPermissionModeToStartOptions(
        applyResumePreference({ cwd: activeWs.path, ...opts }, settings),
        settings
      )
    )
  })

  ipcMain.handle(IPC_CHANNELS.PI_STATUS, async () => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi) return { status: 'stopped', pid: null, error: null }
    return pi.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.PI_DETECT_INSTALLATIONS, async () => ({
    installations: detectPiInstallations(),
  }))

  // ─── Pi Commands ────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PI_PROMPT, async (_event, message: unknown, options?: unknown) => {
    if (!isString(message)) throw new Error('message must be a string')
    const cmd: Record<string, unknown> = { type: 'prompt', message }
    if (isObject(options)) {
      if (options.images) cmd.images = options.images
      if (options.streamingBehavior) cmd.streamingBehavior = options.streamingBehavior
    }
    return getActivePi().sendCommand(cmd)
  })

  ipcMain.handle(IPC_CHANNELS.PI_STEER, async (_event, message: unknown, images?: unknown) => {
    if (!isString(message)) throw new Error('message must be a string')
    const cmd: Record<string, unknown> = { type: 'steer', message }
    if (Array.isArray(images) && images.length > 0) cmd.images = images
    return getActivePi().sendCommand(cmd)
  })

  ipcMain.handle(IPC_CHANNELS.PI_FOLLOW_UP, async (_event, message: unknown) => {
    if (!isString(message)) throw new Error('message must be a string')
    return getActivePi().sendCommand({ type: 'follow_up', message })
  })

  ipcMain.handle(IPC_CHANNELS.PI_ABORT, async () => {
    return getActivePi().sendCommand({ type: 'abort' })
  })

  ipcMain.handle(IPC_CHANNELS.PI_BASH, async (_event, command: unknown) => {
    if (!isString(command)) throw new Error('command must be a string')
    return getActivePi().sendCommand({ type: 'bash', command })
  })

  ipcMain.handle(IPC_CHANNELS.PI_ABORT_BASH, async () => {
    return getActivePi().sendCommand({ type: 'abort_bash' })
  })
}
