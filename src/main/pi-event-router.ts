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
  getSecondaryManager?(): PiRpcManager | null
  preferSecondaryView?(): boolean
  sendSecondaryEvent?(manager: PiRpcManager, event: PiRpcEvent): void
  sendSecondaryApproval?(manager: PiRpcManager, request: PiExtensionUiRequest | null): void
}

export interface PiEventRouter {
  /** Wire a manager's event/status-change/exit emissions into the router. Idempotent. */
  attachManager(manager: PiRpcManager): void
  /** Answer an extension-UI request, routing to its origin manager. */
  respond(id: string, response: Record<string, unknown>, owner?: 'main' | 'secondary'): void
  /** (Re-)deliver the workspace's held dialog; no-op unless it is active now. */
  flush(workspaceId: string): void
  /** Snapshot of held prompts; reaps timed-out ones so the figures stay honest. */
  getPendingCounts(): PendingPromptCounts
  /** Re-broadcast counts after an active-workspace change; delivers nothing. */
  handleActiveWorkspaceChanged(): void
  refreshOwners(): void
  getSecondaryRequest(): PiExtensionUiRequest | null
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
  const owners = new Map<PiRpcManager, 'main' | 'secondary'>()
  const seenBlockingIds = new Set<string>()
  const attached = new WeakSet<PiRpcManager>()

  const isBlockingDialog = (event: PiRpcEvent): event is PiExtensionUiRequest =>
    event.type === 'extension_ui_request' && BLOCKING_UI_METHODS.has(event.method)

  const activeWorkspaceId = (): string | null => {
    const manager = deps.getActiveManager()
    return manager ? deps.workspaceIdFor(manager) : null
  }

  const track = (event: PiExtensionUiRequest): QueuedPrompt => ({ event, receivedAt: deps.now() })

  const ownerFor = (manager: PiRpcManager): 'main' | 'secondary' | null => {
    if (manager === deps.getSecondaryManager?.() &&
      (deps.preferSecondaryView?.() || manager !== deps.getActiveManager())) return 'secondary'
    return manager === deps.getActiveManager() ? 'main' : null
  }
  const revoke = (manager: PiRpcManager, entry: QueuedPrompt): void => {
    if (owners.get(manager) === 'secondary') deps.sendSecondaryApproval?.(manager, null)
    else if (owners.get(manager) === 'main') deps.broadcastEvent({ type: 'extension_ui_request', method: 'cancel', id: entry.event.id, targetId: entry.event.id })
    owners.delete(manager)
  }
  const publish = (manager: PiRpcManager, entry: QueuedPrompt): void => {
    const owner = ownerFor(manager)
    if (owners.has(manager) && owners.get(manager) !== owner) revoke(manager, entry)
    if (!owner) return
    owners.set(manager, owner)
    if (owner === 'secondary') deps.sendSecondaryApproval?.(manager, entry.event)
    else deps.broadcastEvent(entry.event)
  }

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
    for (const [manager, entry] of delivered) {
      if (!isExpired(entry)) continue
      revoke(manager, entry)
      origins.delete(entry.event.id)
      delivered.delete(manager)
      // A reaped slot must not strand a queued dialog behind it. Pi resolves
      // an expired request itself without a cancel event, so nothing else
      // would move the queue until an unrelated flush: promote the next live
      // prompt now, for the reaped manager only while it still owns a view.
      if (queues.has(manager) && ownerFor(manager)) deliverNext(manager)
    }
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
      publish(manager, next)
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
    if (seenBlockingIds.has(event.id)) return
    seenBlockingIds.add(event.id)
    origins.set(event.id, manager)
    if (ownerFor(manager) && !delivered.has(manager)) {
      const entry = track(event)
      delivered.set(manager, entry)
      publish(manager, entry)
    } else enqueue(manager, event)
    emitCounts()
  }

  const handleManagerEvent = (manager: PiRpcManager, event: PiRpcEvent): void => {
    if (event.type === 'extension_ui_request' && event.method === 'cancel' && event.targetId &&
      origins.get(event.targetId) === manager) {
      const id = event.targetId
      origins.delete(id)
      storeQueue(manager, (queues.get(manager) ?? []).filter((entry) => entry.event.id !== id))
      const held = delivered.get(manager)
      if (held?.event.id === id) {
        revoke(manager, held)
        delivered.delete(manager)
      }
      if (ownerFor(manager)) deliverNext(manager)
      emitCounts()
      return
    }
    if (isBlockingDialog(event)) {
      handleBlockingDialog(manager, event)
      return
    }
    deps.sendSecondaryEvent?.(manager, event)
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
      if (ownedIds.has(entry.event.id)) {
        revoke(manager, entry)
        delivered.delete(manager)
      }
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
      deps.sendSecondaryEvent?.(manager, { type: 'status_change', ...manager.getStatus() })
      if (manager === deps.getActiveManager()) {
        deps.broadcastEvent({ type: 'status_change', ...manager.getStatus() })
      }
      if (status !== 'running') evictManager(manager)
    })
    // A startup-phase flip keeps status 'starting', so it is a separate signal:
    // routing it through 'status-change' would re-run evictManager and purge
    // extension UI prompts the still-starting engine already sent.
    manager.on('startup-phase', () => {
      deps.sendSecondaryEvent?.(manager, { type: 'status_change', ...manager.getStatus() })
      if (manager === deps.getActiveManager()) {
        deps.broadcastEvent({ type: 'status_change', ...manager.getStatus() })
      }
    })
    manager.on('exit', () => evictManager(manager))
  }

  const respond = (id: string, response: Record<string, unknown>, owner: 'main' | 'secondary' = 'main'): void => {
    getPendingCounts()
    const origin = origins.get(id)
    const held = origin ? delivered.get(origin) : undefined
    if (!origin || !held || held.event.id !== id || owners.get(origin) !== owner) return
    const keys = Object.keys(response)
    // Cancel is a first-class answer for every blocking method: the engine
    // resolves select/input/editor to undefined and confirm to false. An
    // explicit { value: '' } stays a real value submission, so a select cancel
    // must never be disguised as an empty option.
    const valid =
      (keys.length === 1 && keys[0] === 'cancelled' && response.cancelled === true) ||
      (held.event.method === 'confirm'
        ? keys.length === 1 && keys[0] === 'confirmed' && typeof response.confirmed === 'boolean'
        : keys.length === 1 && keys[0] === 'value' &&
          (typeof response.value === 'string' || response.value === undefined))
    if (!valid) throw new Error('Invalid extension UI response')
    if (held.event.method === 'select' && 'value' in response && typeof response.value === 'string' &&
      !held.event.options?.includes(response.value)) throw new Error('Invalid selection')
    origins.delete(id)
    revoke(origin, held)
    delivered.delete(origin)
    origin.sendExtensionUiResponse(id, response)
    if (ownerFor(origin)) deliverNext(origin)
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
      publish(manager, held)
      return
    }
    if (held !== undefined) {
      // The slot's dialog timed out while the workspace was away: releasing it
      // lets the next queued dialog take the slot instead of waiting on an
      // answer Pi would discard.
      revoke(manager, held)
      delivered.delete(manager)
      origins.delete(held.event.id)
    }
    const promoted = deliverNext(manager)
    if (held !== undefined || promoted) emitCounts()
  }

  const refreshOwners = (): void => {
    getPendingCounts()
    for (const [manager, entry] of delivered) publish(manager, entry)
    const active = deps.getActiveManager()
    const secondary = deps.getSecondaryManager?.()
    if (active && ownerFor(active)) deliverNext(active)
    if (secondary && secondary !== active && ownerFor(secondary)) deliverNext(secondary)
    emitCounts()
  }
  return {
    attachManager,
    respond,
    flush,
    getPendingCounts,
    handleActiveWorkspaceChanged: () => {
      getPendingCounts()
      for (const [manager, entry] of delivered) publish(manager, entry)
      emitCounts()
    },
    refreshOwners,
    getSecondaryRequest: () => {
      getPendingCounts()
      const manager = deps.getSecondaryManager?.()
      return manager && owners.get(manager) === 'secondary' ? delivered.get(manager)?.event ?? null : null
    },
  }
}
