import type { PiRpcManager } from './pi-rpc-manager'
import type {
  PendingPromptCounts,
  PiExtensionUiRequest,
  PiProcessStatus,
  PiRpcEvent,
} from '../shared/ipc-contracts'

/**
 * Routes Pi events from every workspace's PiRpcManager to the renderer.
 *
 * Non-dialog events keep the deliberate active-workspace-only filter: the
 * renderer's piStatus/stream state is a single global view and must track the
 * active workspace. Blocking extension-UI dialogs (select/confirm/input/editor)
 * are different — Pi holds the tool call until an answer arrives, with no
 * timeout on permission confirms — so dropping one from an inactive workspace
 * deadlocks that workspace's turn. The router instead:
 *
 *  - retains the one delivered dialog per workspace (renderer slot is
 *    reconstructible from main state at any moment via flush),
 *  - queues further dialogs per workspace and serializes delivery,
 *  - remembers each request's origin manager so the answer always reaches the
 *    Pi that asked, regardless of which workspace is active at answer time,
 *  - evicts a manager's held prompts when its process stops (a dead Pi can
 *    never consume an answer).
 *
 * Electron-free factory: all I/O goes through injected deps, so tests drive it
 * with bare emitters and an injected clock.
 */

const BLOCKING_UI_METHODS: ReadonlySet<PiExtensionUiRequest['method']> = new Set([
  'select',
  'confirm',
  'input',
  'editor',
])

interface QueuedPrompt {
  event: PiExtensionUiRequest
  receivedAt: number
}

export interface PiEventRouterDeps {
  getActiveManager(): PiRpcManager | null
  workspaceIdFor(manager: PiRpcManager): string | null
  /** Forward one Pi event to the renderer (EVENT_PI). */
  broadcastEvent(event: PiRpcEvent): void
  /** Push a fresh pending-prompt snapshot to the renderer (EVENT_PENDING_PROMPTS). */
  broadcastPendingCounts(counts: PendingPromptCounts): void
  now(): number
}

export interface PiEventRouter {
  /** Wire a manager's event/status-change/exit emissions into the router. Idempotent. */
  attachManager(manager: PiRpcManager): void
  /** Answer an extension-UI request, routing to its origin manager. */
  respond(id: string, response: Record<string, unknown>): void
  /** (Re-)deliver the workspace's held dialog; no-op unless it is active now. */
  flush(workspaceId: string): void
  /** Snapshot of held prompts; reaps timed-out ones so the figures stay honest. */
  getPendingCounts(): PendingPromptCounts
  /** Re-broadcast counts after an active-workspace change; delivers nothing. */
  handleActiveWorkspaceChanged(): void
}

export function createPiEventRouter(deps: PiEventRouterDeps): PiEventRouter {
  // Blocking dialogs are owned by a Pi process, not a project. Multiple live
  // session runtimes may share one workspace cwd, so workspace-keyed queues
  // would deliver one session's prompt to another.
  const queues = new Map<PiRpcManager, QueuedPrompt[]>()
  // The one dialog currently owned by the renderer slot per Pi process. The
  // full payload is retained until answered or evicted so flush can replay it.
  const delivered = new Map<PiRpcManager, QueuedPrompt>()
  // Every blocking dialog's asking manager, until answered or evicted.
  const origins = new Map<string, PiRpcManager>()
  const attached = new WeakSet<PiRpcManager>()

  const isBlockingDialog = (event: PiRpcEvent): event is PiExtensionUiRequest =>
    event.type === 'extension_ui_request' && BLOCKING_UI_METHODS.has(event.method)

  const activeWorkspaceId = (): string | null => {
    const manager = deps.getActiveManager()
    return manager ? deps.workspaceIdFor(manager) : null
  }

  const track = (event: PiExtensionUiRequest): QueuedPrompt => ({ event, receivedAt: deps.now() })

  /**
   * Once the extension-supplied timeout elapses, Pi has auto-resolved the
   * request and deleted its pending entry, so a dialog shown from here on could
   * never be answered. Sole expiry rule for held prompts, queued or delivered.
   */
  const isExpired = (entry: QueuedPrompt): boolean =>
    entry.event.timeout !== undefined && deps.now() - entry.receivedAt >= entry.event.timeout

  /** Drop expired entries, forgetting their origins; returns the live ones. */
  const reapExpired = (entries: readonly QueuedPrompt[]): QueuedPrompt[] => {
    const live: QueuedPrompt[] = []
    for (const entry of entries) {
      if (isExpired(entry)) origins.delete(entry.event.id)
      else live.push(entry)
    }
    return live
  }

  /** An empty queue is deleted rather than stored, so counts omit zero entries. */
  const storeQueue = (manager: PiRpcManager, entries: QueuedPrompt[]): void => {
    if (entries.length === 0) queues.delete(manager)
    else queues.set(manager, entries)
  }

  const getPendingCounts = (): PendingPromptCounts => {
    const counts: PendingPromptCounts = {}
    for (const [manager, entries] of queues) {
      const live = reapExpired(entries)
      if (live.length !== entries.length) storeQueue(manager, live)
      const workspaceId = deps.workspaceIdFor(manager)
      if (workspaceId && live.length > 0) counts[workspaceId] = (counts[workspaceId] ?? 0) + live.length
    }
    for (const manager of delivered.keys()) {
      const workspaceId = deps.workspaceIdFor(manager)
      if (workspaceId) counts[workspaceId] = (counts[workspaceId] ?? 0) + 1
    }
    return counts
  }

  const emitCounts = (): void => {
    deps.broadcastPendingCounts(getPendingCounts())
  }

  /**
   * Pop the workspace's queue into its empty delivered slot and broadcast,
   * reaping expired entries on the way. Returns whether state changed.
   */
  const deliverNext = (manager: PiRpcManager): boolean => {
    if (delivered.has(manager)) return false
    const entries = queues.get(manager)
    if (entries === undefined) return false
    const live = reapExpired(entries)
    const next = live.shift()
    if (next !== undefined) {
      delivered.set(manager, next)
      deps.broadcastEvent(next.event)
    }
    storeQueue(manager, live)
    return live.length !== entries.length
  }

  const enqueue = (manager: PiRpcManager, event: PiExtensionUiRequest): void => {
    const entry = track(event)
    const queue = queues.get(manager)
    if (queue) queue.push(entry)
    else queues.set(manager, [entry])
  }

  const handleBlockingDialog = (manager: PiRpcManager, event: PiExtensionUiRequest): void => {
    origins.set(event.id, manager)
    const workspaceId = deps.workspaceIdFor(manager)
    if (workspaceId === null) {
      // Manager unknown to the workspace registry: there is no queue slot to
      // hold it under, so deliver directly when active (origin routing above
      // still answers it) and let the inactive case fall through as a drop.
      if (manager === deps.getActiveManager()) deps.broadcastEvent(event)
      return
    }
    if (manager === deps.getActiveManager() && !delivered.has(manager)) {
      delivered.set(manager, track(event))
      deps.broadcastEvent(event)
    } else {
      // Inactive session runtime, or a dialog already on screen: hold for later.
      enqueue(manager, event)
    }
    emitCounts()
  }

  const handleManagerEvent = (manager: PiRpcManager, event: PiRpcEvent): void => {
    if (isBlockingDialog(event)) {
      handleBlockingDialog(manager, event)
      return
    }
    if (manager === deps.getActiveManager()) {
      deps.broadcastEvent(event)
    }
  }

  /**
   * A manager that stopped, crashed, or is restarting has abandoned its
   * pending requests: purge every prompt it originated so none can ghost-
   * deliver against a process that will never consume the answer.
   */
  const evictManager = (manager: PiRpcManager): void => {
    const ownedIds = new Set<string>()
    for (const [id, origin] of origins) {
      if (origin === manager) ownedIds.add(id)
    }
    if (ownedIds.size === 0) return
    for (const id of ownedIds) origins.delete(id)
    for (const [manager, entries] of queues) {
      const kept = entries.filter((entry) => !ownedIds.has(entry.event.id))
      if (kept.length !== entries.length) storeQueue(manager, kept)
    }
    for (const [manager, entry] of delivered) {
      if (ownedIds.has(entry.event.id)) delivered.delete(manager)
    }
    emitCounts()
  }

  const attachManager = (manager: PiRpcManager): void => {
    // WorkspaceManager's wiredPairs already dedups its listener attachment;
    // this guard makes the router safe against any second wiring path.
    if (attached.has(manager)) return
    attached.add(manager)
    manager.on('event', (event: PiRpcEvent) => handleManagerEvent(manager, event))
    manager.on('status-change', (status: PiProcessStatus) => {
      if (manager === deps.getActiveManager()) {
        deps.broadcastEvent({ type: 'status_change', ...manager.getStatus() })
      }
      if (status !== 'running') evictManager(manager)
    })
    manager.on('exit', () => evictManager(manager))
  }

  const respond = (id: string, response: Record<string, unknown>): void => {
    const origin = origins.get(id) ?? null
    origins.delete(id)
    // Purge the id everywhere FIRST — regardless of a routing hit — so an
    // answered request can never linger as a queued or delivered ghost.
    let purgedManager: PiRpcManager | null = null
    for (const [manager, entries] of queues) {
      const kept = entries.filter((entry) => entry.event.id !== id)
      if (kept.length === entries.length) continue
      purgedManager = manager
      storeQueue(manager, kept)
    }
    for (const [manager, entry] of delivered) {
      if (entry.event.id !== id) continue
      delivered.delete(manager)
      purgedManager = manager
    }
    // Origin miss (notify dismissal, evicted prompt): fall back to the active
    // manager — Pi ignores unknown ids — or drop when no workspace is active.
    const target = origin ?? deps.getActiveManager()
    target?.sendExtensionUiResponse(id, response)
    if (purgedManager !== null && purgedManager === deps.getActiveManager()) {
      deliverNext(purgedManager)
    }
    emitCounts()
  }

  const flush = (workspaceId: string): void => {
    // Only the active workspace and its active session runtime may be flushed:
    // a stale flush must not resurface another session's dialog.
    if (workspaceId !== activeWorkspaceId()) return
    const manager = deps.getActiveManager()
    if (!manager) return
    const held = delivered.get(manager)
    if (held !== undefined && !isExpired(held)) {
      // Self-healing re-broadcast: rebuilds the renderer slot after a reload,
      // a switch-back, or a same-workspace re-activation. The renderer's
      // id-guard tolerates the duplicate when the dialog is already up.
      deps.broadcastEvent(held.event)
      return
    }
    if (held !== undefined) {
      // The slot's dialog timed out while the workspace was away: releasing it
      // lets the next queued dialog take the slot instead of waiting on an
      // answer Pi would discard.
      delivered.delete(manager)
      origins.delete(held.event.id)
    }
    const promoted = deliverNext(manager)
    if (held !== undefined || promoted) emitCounts()
  }

  return {
    attachManager,
    respond,
    flush,
    getPendingCounts,
    handleActiveWorkspaceChanged: emitCounts,
  }
}
