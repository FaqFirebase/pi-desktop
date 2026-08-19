import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createExtensionUiRouter, wireExtensionUiIpc } from './extension-ui-ipc'
import { WorkspaceManager } from './workspace-manager'
import { IPC_CHANNELS } from '../shared/ipc-contracts'
import { createIpcContext } from './ipc/context'
import { assertTrustedSender } from './ipc/validation'
import { registerPiHandlers } from './ipc/pi-handlers'
import { registerTerminalHandlers } from './ipc/terminal-handlers'
import { registerSessionHandlers } from './ipc/session-handlers'
import { registerModelHandlers } from './ipc/model-handlers'
import { registerSettingsHandlers } from './ipc/settings'
import { registerPermissionRulesHandlers } from './ipc/permission-rules-handlers'
import { registerThemeHandlers } from './ipc/theme-handlers'
import { registerWorkspaceHandlers } from './ipc/workspace-handlers'
import { registerPackageHandlers } from './ipc/package-handlers'
import { registerSkillsMcpHandlers } from './ipc/skills-mcp-handlers'
import { registerModelsConfigHandlers } from './ipc/models-config-handlers'
import { registerCouncilHandlers } from './ipc/council-handlers'
import { registerTagHandlers } from './ipc/tag-handlers'
import { registerNotesHandlers } from './ipc/notes-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerSystemHandlers } from './ipc/system-handlers'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerDiagnosticsHandlers } from './ipc/diagnostics-handlers'
import { registerWorkflowHandlers } from './ipc/workflow-handlers'
import { wireWorkspaceActivity, type WindowControls } from './ipc/workspace-activity-wiring'

export { loadAppSettings, saveAppSettings } from './ipc/settings'

/**
 * Registers all IPC handlers that the renderer can invoke.
 *
 * Security: every handler validates its input types before processing.
 * The preload bridge is the only path from renderer to these handlers.
 */
export function registerIpcHandlers(
  workspaceManager: WorkspaceManager,
  windowControls: WindowControls = { getWindow: () => null, showWindow: () => {} },
): void {
  const ctx = createIpcContext(workspaceManager)

  registerPiHandlers(ctx)
  registerTerminalHandlers(ctx)
  registerSessionHandlers(ctx)
  registerModelHandlers(ctx)
  registerSettingsHandlers(ctx)
  registerPermissionRulesHandlers(ctx)
  registerThemeHandlers()
  registerWorkspaceHandlers(ctx)
  registerPackageHandlers(ctx)
  registerSkillsMcpHandlers(ctx)
  registerModelsConfigHandlers()
  registerCouncilHandlers(ctx)
  registerTagHandlers(ctx)
  registerNotesHandlers(ctx)
  registerFileHandlers(ctx)
  registerSystemHandlers(ctx)
  registerUpdateHandlers()
  registerDiagnosticsHandlers(ctx)
  registerWorkflowHandlers(ctx)

  // ─── Extension UI Responses and Pi Event Forwarding ─────────────────────

  // Cross-workspace activity map + desktop notifications. Wired before the
  // router so it can observe the router's pending-prompt counts below.
  const workspaceActivity = wireWorkspaceActivity(ctx, windowControls)

  // Router construction, the dialog-answer channels, the pending-prompt
  // flush/get pair and the two workspace hooks all live in extension-ui-ipc.ts
  // so they can be tested without Electron.
  wireExtensionUiIpc<IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    router: createExtensionUiRouter({
      workspace: workspaceManager,
      broadcast: ctx.broadcast,
      onPendingCounts: (counts) => workspaceActivity.handlePendingCounts(counts),
    }),
    workspace: workspaceManager,
    broadcast: ctx.broadcast,
  })

  // Forward debounced file-change events from the active workspace's watcher
  // so the renderer can refresh the file tree and git status live. The
  // WorkspaceManager only watches the active workspace, so no filtering here.
  workspaceManager.onFileChange((event) => {
    ctx.broadcast(IPC_CHANNELS.EVENT_FILE_CHANGE, event)
  })
}
