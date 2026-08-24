import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { access } from 'fs/promises'
import { isString, isObject } from './validation'
import { validateStartOptions, applyResumePreference, applyPermissionModeToStartOptions } from './pi-start-options'
import { loadAppSettings } from './settings'
import type { IpcContext } from './context'
import { detectPiInstallations, getConfiguredEngineKind } from '../pi-rpc-manager'

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

    // Restart the runtime, not just its process: the runtime owns the session
    // binding, and restartSessionRuntime re-applies it. Starting the manager
    // directly would drop it — `--continue` picks whatever file on disk is
    // newest (possibly another live runtime's), and without the resume setting
    // Pi opens a blank session, either way leaving the tab lying about which
    // session it shows.
    const runtimeId = workspaceManager.runtimeIdFor(pi)
    const runtime = runtimeId ? workspaceManager.getSessionRuntime(runtimeId) : null
    const startOptions = applyPermissionModeToStartOptions(
      applyResumePreference({ cwd: activeWs.path, ...opts }, settings),
      settings
    )
    if (runtime) {
      const info = await workspaceManager.restartSessionRuntime(runtime.runtimeId, startOptions)
      return { status: info.status, pid: info.pid, error: info.error }
    }

    pi.stop()
    return pi.start(startOptions)
  })

  ipcMain.handle(IPC_CHANNELS.PI_STATUS, async () => {
    const pi = workspaceManager.getActivePiManager()
    // No manager yet is the normal state at launch. Report the engine that
    // would start anyway, or the status bar names Pi until something runs.
    if (!pi) return { status: 'stopped', pid: null, error: null, engine: getConfiguredEngineKind() }
    return pi.getStatus()
  })

  // `{ force: true }` is what the Rescan button must send: without it the
  // handler may answer from a cache up to 30 s old and an engine installed
  // moments ago never appears.
  ipcMain.handle(IPC_CHANNELS.PI_DETECT_INSTALLATIONS, async (_event, options?: unknown) => ({
    installations: detectPiInstallations(isObject(options) && options.force === true),
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
