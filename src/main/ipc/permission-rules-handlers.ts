import { ipcMain, dialog } from 'electron'
import { WorkspaceManager } from '../workspace-manager'
import type {
  PermissionRulesScope,
  PermissionRulesGetResult,
  PermissionRulesSetResult,
  PermissionRulesImportResult,
  PermissionRulesExportResult,
  PermissionRulesWorkspaceStatus,
  PermissionRulesRemoveResult,
  PermissionRulesFile,
} from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readFile, writeFile, mkdir, stat, unlink } from 'fs/promises'
import { dirname } from 'path'
import { existsSync } from 'fs'
import { workspaceTrustStore } from '../workspace-trust'
import {
  PERMISSION_RULES_FILE_NAME,
  PERMISSION_RULES_VERSION,
  loadEffectiveRules,
  validatePermissionRulesFile,
  workspaceRulesPath,
} from '../../../resources/permission-rules'
import { assertTrustedSender } from './validation'
import { getGlobalPermissionRulesPath, applyResumePreference, applyPermissionModeToStartOptions } from './pi-start-options'
import { loadAppSettings, saveAppSettings } from './settings'
import type { IpcContext } from './context'

const MAX_PERMISSION_RULES_FILE_BYTES = 512 * 1024
const PERMISSION_RULES_FILE_FILTER: Electron.FileFilter = { name: 'Permission Rules', extensions: ['json'] }

function validatePermissionRulesScope(scope: unknown): PermissionRulesScope {
  if (scope === 'global' || scope === 'workspace') return scope
  throw new Error('scope must be "global" or "workspace"')
}

function activeWorkspaceRulesPath(workspaceManager: WorkspaceManager): { path: string; workspacePath: string } {
  const activeWs = workspaceManager.getActiveWorkspace()
  if (!activeWs) throw new Error('No active workspace')
  return { path: workspaceRulesPath(activeWs.path), workspacePath: activeWs.path }
}

/** Also consumed by the diagnostics report. */
export async function buildWorkspaceRulesStatus(
  workspaceManager: WorkspaceManager,
): Promise<PermissionRulesWorkspaceStatus> {
  const activeWs = workspaceManager.getActiveWorkspace()
  if (!activeWs) {
    return { hasWorkspaceRules: false, workspacePath: null, acknowledged: false, trusted: false, hasAllowRules: false }
  }
  const settings = await loadAppSettings(workspaceManager)
  // Read the workspace's own rules (as if trusted, no global) purely to detect
  // whether it contains allow rules — the only case where trust matters.
  const workspaceOwnRules = loadEffectiveRules(activeWs.path, null, { workspaceTrusted: true })
  const hasAllowRules =
    workspaceOwnRules.source === 'workspace' && workspaceOwnRules.rules.some((r) => r.action === 'allow')
  return {
    hasWorkspaceRules: existsSync(workspaceRulesPath(activeWs.path)),
    workspacePath: activeWs.path,
    acknowledged: settings.permissionRulesAckWorkspaces.includes(activeWs.path),
    trusted: workspaceTrustStore.isTrusted(activeWs.path),
    hasAllowRules,
  }
}

export function registerPermissionRulesHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx

  // ─── Permission Rules ───────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RULES_GET, async (_event, scope: unknown): Promise<PermissionRulesGetResult> => {
    try {
      let rulesPath: string
      if (validatePermissionRulesScope(scope) === 'global') {
        rulesPath = getGlobalPermissionRulesPath()
      } else {
        // No active workspace means no workspace file — not an error, so the
        // panel never mistakes this state for a corrupt file.
        const activeWs = workspaceManager.getActiveWorkspace()
        if (!activeWs) return { ok: true, rules: [], exists: false }
        rulesPath = workspaceRulesPath(activeWs.path)
      }
      if (!existsSync(rulesPath)) return { ok: true, rules: [], exists: false }
      const file = validatePermissionRulesFile(JSON.parse(await readFile(rulesPath, 'utf-8')))
      return { ok: true, rules: file.rules, exists: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RULES_SET, async (_event, scope: unknown, rules: unknown): Promise<PermissionRulesSetResult> => {
    try {
      const validScope = validatePermissionRulesScope(scope)
      const file = validatePermissionRulesFile({ version: PERMISSION_RULES_VERSION, rules })
      if (validScope === 'global') {
        const rulesPath = getGlobalPermissionRulesPath()
        await mkdir(dirname(rulesPath), { recursive: true })
        await writeFile(rulesPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
        return { ok: true }
      }
      const { path: rulesPath, workspacePath } = activeWorkspaceRulesPath(workspaceManager)
      await mkdir(dirname(rulesPath), { recursive: true })
      await writeFile(rulesPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
      // The user created this file deliberately — acknowledge the workspace so
      // the one-time "workspace has its own rules" notice never fires for it.
      const settings = await loadAppSettings(workspaceManager)
      if (!settings.permissionRulesAckWorkspaces.includes(workspacePath)) {
        await saveAppSettings({
          permissionRulesAckWorkspaces: [...settings.permissionRulesAckWorkspaces, workspacePath],
        })
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RULES_IMPORT, async (): Promise<PermissionRulesImportResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Import Permission Rules',
      properties: ['openFile'],
      filters: [PERMISSION_RULES_FILE_FILTER],
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const filePath = result.filePaths[0]
      const { size } = await stat(filePath)
      if (size > MAX_PERMISSION_RULES_FILE_BYTES) {
        return { ok: false, error: `rules file too large (limit ${MAX_PERMISSION_RULES_FILE_BYTES} bytes)` }
      }
      const file = validatePermissionRulesFile(JSON.parse(await readFile(filePath, 'utf-8')))
      return { ok: true, rules: file.rules }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RULES_EXPORT, async (_event, rules: unknown): Promise<PermissionRulesExportResult> => {
    let file: PermissionRulesFile
    try {
      file = validatePermissionRulesFile({ version: PERMISSION_RULES_VERSION, rules })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const result = await dialog.showSaveDialog({
      title: 'Export Permission Rules',
      defaultPath: PERMISSION_RULES_FILE_NAME,
      filters: [PERMISSION_RULES_FILE_FILTER],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      await writeFile(result.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
      return { ok: true }
    } catch (error) {
      console.error('Failed to write exported permission rules file:', error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RULES_WORKSPACE_STATUS, async (): Promise<PermissionRulesWorkspaceStatus> => {
    return buildWorkspaceRulesStatus(workspaceManager)
  })

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RULES_SET_WORKSPACE_TRUST,
    async (event, trusted: unknown): Promise<PermissionRulesWorkspaceStatus> => {
      assertTrustedSender(event)
      if (typeof trusted !== 'boolean') throw new Error('trusted must be a boolean')
      const activeWs = workspaceManager.getActiveWorkspace()
      if (!activeWs) throw new Error('No active workspace')

      if (trusted !== workspaceTrustStore.isTrusted(activeWs.path)) {
        if (trusted) {
          await workspaceTrustStore.trust(activeWs.path)
        } else {
          await workspaceTrustStore.revoke(activeWs.path)
        }

        // Trust is read into PI_DESKTOP_WORKSPACE_TRUSTED at spawn time and
        // gates the preview guest at attach time. Restart every live session
        // runtime in this workspace, not only the foreground one.
        const fresh = await loadAppSettings(workspaceManager)
        const liveRuntimes = workspaceManager
          .getSessionRuntimes(activeWs.id)
          .filter((runtime) => runtime.status === 'running')
        if (liveRuntimes.length > 0) {
          await Promise.all(liveRuntimes.map((runtime) =>
            workspaceManager.restartSessionRuntime(
              runtime.runtimeId,
              applyPermissionModeToStartOptions(applyResumePreference({ cwd: activeWs.path }, fresh), fresh)
            )
          ))
        } else {
          const pi = workspaceManager.getPiManager(activeWs.id)
          if (pi && pi.getStatus().status === 'running') {
            pi.stop()
            await pi.start(
              applyPermissionModeToStartOptions(applyResumePreference({ cwd: activeWs.path }, fresh), fresh)
            )
          }
        }
      }
      return buildWorkspaceRulesStatus(workspaceManager)
    }
  )

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RULES_REMOVE_WORKSPACE, async (): Promise<PermissionRulesRemoveResult> => {
    try {
      const { path: rulesPath } = activeWorkspaceRulesPath(workspaceManager)
      await unlink(rulesPath)
      return { ok: true }
    } catch (error) {
      // Already gone is still success — the caller's goal (no workspace rules
      // file) is met either way.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
