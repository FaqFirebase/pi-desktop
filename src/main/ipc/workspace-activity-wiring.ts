import { ipcMain, Notification, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { PiProcessStatus } from '../../shared/ipc-contracts'
import {
  createWorkspaceActivityTracker,
  type WorkspaceActivityNotification,
  type WorkspaceActivityTracker,
} from '../workspace-activity'
import { shouldNotify } from '../notify-decision'
import { appLog } from '../app-log'
import { loadAppSettings } from './settings'
import type { IpcContext } from './context'

const NOTIFICATION_BODIES: Record<WorkspaceActivityNotification['kind'], string> = {
  completed: 'Pi finished working.',
  failed: 'Pi stopped with an error.',
  'needs-approval': 'Pi is waiting for your approval.',
}

export interface WindowControls {
  getWindow(): BrowserWindow | null
  /** Show the main window, creating it if it was fully closed (macOS). */
  showWindow(): void
}

/**
 * Wires the per-workspace activity tracker: feeds it every manager's turn and
 * process signals, broadcasts the derived map to the renderer, registers the
 * snapshot channel, and raises desktop notifications for background events.
 *
 * Returns the tracker so the composition root can feed it the router's
 * pending-prompt counts (the one signal that originates router-side).
 */
export function wireWorkspaceActivity(
  ctx: IpcContext,
  windowControls: WindowControls,
): WorkspaceActivityTracker {
  const { workspaceManager } = ctx
  const { getWindow, showWindow } = windowControls
  // Activation intent from a notification clicked while no window existed;
  // the freshly created renderer pulls it once its subscriptions are live.
  let pendingActivationWorkspaceId: string | null = null

  const showNotification = async (
    notification: WorkspaceActivityNotification,
  ): Promise<void> => {
    const settings = await loadAppSettings(workspaceManager)
    const window = getWindow()
    const permitted = shouldNotify({
      enabled: settings.desktopNotifications,
      windowFocused: window?.isFocused() ?? false,
      eventWorkspaceId: notification.workspaceId,
      activeWorkspaceId: workspaceManager.getActiveWorkspaceId(),
    })
    if (!permitted || !Notification.isSupported()) return

    const workspace = workspaceManager
      .getWorkspaces()
      .find((ws) => ws.id === notification.workspaceId)
    if (!workspace) return

    const osNotification = new Notification({
      title: workspace.name,
      body: NOTIFICATION_BODIES[notification.kind],
    })
    osNotification.on('click', () => {
      // The workspace can be removed between showing and clicking; a stale
      // click should just bring the app forward, not run confirm dialogs for
      // a doomed switch.
      const stillExists = workspaceManager
        .getWorkspaces()
        .some((ws) => ws.id === notification.workspaceId)
      const win = getWindow()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        // The renderer owns workspace activation (it runs the streaming and
        // dirty-editor confirms), so hand it the intent instead of switching
        // main-side and desyncing its store.
        if (stillExists) {
          ctx.broadcast(IPC_CHANNELS.EVENT_ACTIVATE_WORKSPACE, {
            workspaceId: notification.workspaceId,
          })
        }
      } else {
        // macOS: the window may be fully closed. A broadcast now has no
        // windows to reach, and a send at did-finish-load would race the
        // renderer's subscription — stash the intent for the boot-time pull.
        if (stillExists) pendingActivationWorkspaceId = notification.workspaceId
        showWindow()
      }
    })
    osNotification.show()
  }

  const tracker = createWorkspaceActivityTracker({
    getActiveWorkspaceId: () => workspaceManager.getActiveWorkspaceId(),
    now: () => Date.now(),
    onChange: (map) => ctx.broadcast(IPC_CHANNELS.EVENT_WORKSPACE_ACTIVITY, map),
    onNotify: (notification) => {
      void showNotification(notification).catch((err) => {
        appLog.warn('notifications', 'Failed to show desktop notification', err)
      })
    },
  })

  // Every manager (existing and future) feeds the tracker; the workspace id is
  // resolved at event time so pre-registration races cannot mislabel events.
  workspaceManager.onPiManager((manager) => {
    const workspaceIdOf = (): string | null => workspaceManager.workspaceIdFor(manager)
    manager.on('agent_start', () => {
      const id = workspaceIdOf()
      if (id) tracker.handleAgentStart(id)
    })
    manager.on('agent_end', () => {
      const id = workspaceIdOf()
      if (id) tracker.handleAgentEnd(id)
    })
    manager.on('status-change', (status: PiProcessStatus) => {
      const id = workspaceIdOf()
      if (id) tracker.handleStatusChange(id, status)
    })
    // Only unexpected death emits 'exit' (deliberate stop() detaches
    // listeners first) — this is what distinguishes a crash from a stop.
    manager.on('exit', () => {
      const id = workspaceIdOf()
      if (id) tracker.handleProcessExit(id)
    })
  })

  workspaceManager.onActiveWorkspaceChanged((workspaceId) => {
    if (workspaceId) tracker.handleWorkspaceSeen(workspaceId)
  })

  workspaceManager.onWorkspaceRemoved((workspaceId) => {
    tracker.handleWorkspaceRemoved(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_ACTIVITY_GET, async () => tracker.getMap())

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_TAKE_PENDING_ACTIVATION, async () => {
    const workspaceId = pendingActivationWorkspaceId
    pendingActivationWorkspaceId = null
    return workspaceId
  })

  return tracker
}
