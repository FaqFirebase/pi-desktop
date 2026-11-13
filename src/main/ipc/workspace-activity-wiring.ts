import { ipcMain, Notification, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { PiProcessStatus, WorkspaceActivationIntent } from '../../shared/ipc-contracts'
import {
  createWorkspaceActivityTracker,
  type WorkspaceActivityNotification,
  type WorkspaceActivityTracker,
} from '../workspace-activity'
import { shouldNotify } from '../notify-decision'
import { appLog } from '../app-log'
import { loadAppSettings } from './settings'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

// An explicit map, not a template-literal key built from the notification
// kind: `kind`'s type is the indexed-access type
// `WorkspaceActivityNotification['kind']`, and the extractor's static
// analysis cannot trace a template literal through that (verified: a
// directly union-typed parameter, as in permission-mode.ts's
// `getPermissionModeLabel`, extracts fine — an indexed-access type does
// not), so it would report the individual notification keys below as unused.
const NOTIFICATION_KEYS = {
  completed: 'notifications.completed',
  failed: 'notifications.failed',
  'needs-approval': 'notifications.needs-approval',
} as const satisfies Record<WorkspaceActivityNotification['kind'], string>

function notificationBody(kind: WorkspaceActivityNotification['kind'], opensSession: boolean): string {
  const body = t(NOTIFICATION_KEYS[kind])
  return opensSession ? t('notifications.withSession', { body }) : body
}

export interface WindowControls {
  getWindow(): BrowserWindow | null
  /** Show the main window, creating it if it was fully closed (macOS). */
  showWindow(): void
}

const pendingActivations = new WeakMap<IpcContext, WorkspaceActivationIntent>()

/** Both notification clicks and secondary views use the renderer's guarded navigation. */
export function requestWorkspaceActivation(
  ctx: IpcContext,
  windowControls: WindowControls,
  intent: WorkspaceActivationIntent,
): void {
  pendingActivations.set(ctx, intent)
  windowControls.showWindow()
  const window = windowControls.getWindow()
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  ctx.broadcast(IPC_CHANNELS.EVENT_ACTIVATE_WORKSPACE, intent)
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
  iconPath: string,
): WorkspaceActivityTracker {
  const { workspaceManager } = ctx
  const { getWindow, showWindow } = windowControls
  // Activation intent from a notification clicked while no window existed;
  // the freshly created renderer pulls it once its subscriptions are live.

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
      body: notificationBody(notification.kind, Boolean(notification.sessionPath)),
      ...(iconPath ? { icon: iconPath } : {}),
    })
    osNotification.on('click', () => {
      // The workspace can be removed between showing and clicking; a stale
      // click should just bring the app forward, not run confirm dialogs for
      // a doomed switch.
      const stillExists = workspaceManager
        .getWorkspaces()
        .some((ws) => ws.id === notification.workspaceId)
      // Always stash AND broadcast: a webContents.send only lands if the
      // renderer's subscription is already live, which a click during boot,
      // reload, or with the window closed cannot guarantee. A renderer that
      // does receive the broadcast consumes the stash immediately; one that
      // missed it pulls the stash when its subscriptions come up.
      const intent: WorkspaceActivationIntent = {
        workspaceId: notification.workspaceId,
        ...(notification.sessionPath ? { sessionPath: notification.sessionPath } : {}),
        ...(notification.runtimeId ? { runtimeId: notification.runtimeId } : {}),
      }
      if (stillExists) pendingActivations.set(ctx, intent)
      const win = getWindow()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        // The renderer owns workspace activation (it runs the streaming and
        // dirty-editor confirms), so hand it the intent instead of switching
        // main-side and desyncing its store.
        if (stillExists) {
          ctx.broadcast(IPC_CHANNELS.EVENT_ACTIVATE_WORKSPACE, intent)
        }
      } else {
        // macOS: the window may be fully closed — recreate it; the fresh
        // renderer pulls the stashed intent once its subscriptions are live.
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
    const sessionTarget = (): { runtimeId?: string; sessionPath?: string } => {
      const sessionPath = workspaceManager.sessionPathFor(manager)
      const runtimeId = workspaceManager.runtimeIdFor(manager)
      return {
        ...(sessionPath ? { sessionPath } : {}),
        ...(runtimeId ? { runtimeId } : {}),
      }
    }
    manager.on('agent_start', () => {
      const id = workspaceIdOf()
      if (id) tracker.handleAgentStart(id, sessionTarget())
    })
    manager.on('agent_end', () => {
      const id = workspaceIdOf()
      if (id) tracker.handleAgentEnd(id, sessionTarget())
    })
    manager.on('status-change', (status: PiProcessStatus) => {
      const id = workspaceIdOf()
      if (id) tracker.handleStatusChange(id, status, sessionTarget())
    })
    // Only unexpected death emits 'exit' (deliberate stop() detaches
    // listeners first) — this is what distinguishes a crash from a stop.
    manager.on('exit', () => {
      const id = workspaceIdOf()
      if (id) tracker.handleProcessExit(id, sessionTarget())
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
    const intent = pendingActivations.get(ctx) ?? null
    pendingActivations.delete(ctx)
    return intent
  })

  return tracker
}
