import { IPC_CHANNELS, type PendingPromptCounts } from '../shared/ipc-contracts'
import { createPiEventRouter, type PiEventRouter } from './pi-event-router'
import type { PiRpcManager } from './pi-rpc-manager'

/**
 * Wiring for the extension-UI half of the IPC surface: the Pi event router,
 * the four channels that answer a blocking dialog (select/confirm/input/
 * editor), the pending-prompt flush/get pair, and the two workspace hooks that
 * keep them fed.
 *
 * Electron-free: the handler registrar, the sender check, the broadcaster and
 * the workspace registry all arrive as deps, so ipc-handlers passes the real
 * ipcMain.handle / assertTrustedSender / BrowserWindow broadcast /
 * WorkspaceManager while tests drive the same code with recording fakes.
 */

/** Registers one invoke handler; the shape of Electron's ipcMain.handle. */
export type IpcInvokeRegistrar<TEvent> = (
  channel: string,
  handler: (event: TEvent, ...args: unknown[]) => Promise<unknown>,
) => void

/** The slice of WorkspaceManager this wiring depends on. */
export interface ExtensionUiWorkspace {
  getActivePiManager(): PiRpcManager | null
  workspaceIdFor(manager: PiRpcManager): string | null
  onPiManager(listener: (manager: PiRpcManager) => void): void
  onActiveWorkspaceChanged(listener: (workspaceId: string | null) => void): void
}

/** Send one payload to every renderer window. */
export type ChannelBroadcast = (channel: string, data: unknown) => void

export interface ExtensionUiIpcDeps<TEvent> {
  handle: IpcInvokeRegistrar<TEvent>
  /** Rejects any sender frame that is not the app's own renderer. */
  assertTrustedSender: (event: TEvent) => void
  router: PiEventRouter
  workspace: ExtensionUiWorkspace
  broadcast: ChannelBroadcast
}

/**
 * Build the router that carries Pi events to the renderer and holds blocking
 * extension-UI prompts from ANY workspace, so an answer can always reach the
 * Pi that asked — see pi-event-router.ts for the retention rules.
 */
export function createExtensionUiRouter(deps: {
  workspace: ExtensionUiWorkspace
  broadcast: ChannelBroadcast
  /** Optional main-side observer of pending-count changes (activity tracker). */
  onPendingCounts?: (counts: PendingPromptCounts) => void
}): PiEventRouter {
  return createPiEventRouter({
    getActiveManager: () => deps.workspace.getActivePiManager(),
    workspaceIdFor: (manager) => deps.workspace.workspaceIdFor(manager),
    broadcastEvent: (event) => deps.broadcast(IPC_CHANNELS.EVENT_PI, event),
    broadcastPendingCounts: (counts) => {
      deps.onPendingCounts?.(counts)
      deps.broadcast(IPC_CHANNELS.EVENT_PENDING_PROMPTS, counts)
    },
    now: () => Date.now(),
  })
}

export function wireExtensionUiIpc<TEvent>(deps: ExtensionUiIpcDeps<TEvent>): void {
  const { handle, assertTrustedSender, router, workspace, broadcast } = deps

  // All four dialog answers route through the router so they reach the ORIGIN
  // Pi — the one that asked — not whichever workspace happens to be active now.
  const handleDialogResponse = (
    channel: string,
    toResponse: (payload: unknown) => Record<string, unknown>,
  ): void => {
    handle(channel, async (event, id: unknown, payload: unknown) => {
      assertTrustedSender(event)
      if (typeof id !== 'string') throw new Error('id must be a string')
      router.respond(id, toResponse(payload))
    })
  }

  handleDialogResponse(IPC_CHANNELS.UI_SELECT_RESPONSE, (value) => ({ value }))
  handleDialogResponse(IPC_CHANNELS.UI_CONFIRM_RESPONSE, (confirmed) => ({ confirmed: !!confirmed }))
  handleDialogResponse(IPC_CHANNELS.UI_INPUT_RESPONSE, (value) => ({ value }))
  handleDialogResponse(IPC_CHANNELS.UI_EDITOR_RESPONSE, (value) => ({ value }))

  handle(IPC_CHANNELS.UI_PENDING_FLUSH, async (event, workspaceId: unknown) => {
    assertTrustedSender(event)
    if (typeof workspaceId !== 'string') throw new Error('workspaceId must be a string')
    router.flush(workspaceId)
  })

  handle(IPC_CHANNELS.UI_PENDING_GET, async (event) => {
    assertTrustedSender(event)
    return router.getPendingCounts()
  })

  // Every Pi manager feeds the router. It forwards non-dialog events ONLY from
  // the currently-active workspace's manager (the renderer's piStatus is a
  // single global, so status from inactive workspaces would make the green dot
  // lie), while blocking extension-UI dialogs from ANY workspace are retained
  // and queued instead of dropped — dropping one deadlocks that workspace's
  // turn, since Pi holds the tool call until an answer arrives.
  workspace.onPiManager((manager) => {
    router.attachManager(manager)
  })

  // Push the active workspace's Pi status to the renderer whenever the active
  // workspace changes, so the status indicator reflects the new workspace
  // even if its Pi manager hasn't emitted any events recently. The router's
  // counts re-broadcast keeps the pending-prompt badges in step with it.
  workspace.onActiveWorkspaceChanged(() => {
    const pi = workspace.getActivePiManager()
    if (pi) broadcast(IPC_CHANNELS.EVENT_PI, { type: 'status_change', ...pi.getStatus() })
    router.handleActiveWorkspaceChanged()
  })
}
