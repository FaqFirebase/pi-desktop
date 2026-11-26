import type { SessionRuntimeInfo, Workspace } from '../../../shared/ipc-contracts'

export const PROJECT_TAB_ORDER_STORAGE_KEY = 'pi-desktop.project-tab-order'
export const HIDDEN_PROJECT_TABS_STORAGE_KEY = 'pi-desktop.hidden-project-tabs'

function readStoredIds(key: string): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? [...new Set(ids)] : []
  } catch {
    // Missing/unavailable storage or a damaged preference uses the default.
    return []
  }
}

function storeIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // The change still applies to this window when storage is unavailable.
  }
}

export function readProjectTabOrder(): string[] {
  return readStoredIds(PROJECT_TAB_ORDER_STORAGE_KEY)
}

export function rememberProjectTabOrder(order: string[]): void {
  storeIds(PROJECT_TAB_ORDER_STORAGE_KEY, order)
}

/** Projects whose tab the user closed while keeping them in the sidebar. */
export function readHiddenProjectTabs(): string[] {
  return readStoredIds(HIDDEN_PROJECT_TABS_STORAGE_KEY)
}

export function rememberHiddenProjectTabs(ids: string[]): void {
  storeIds(HIDDEN_PROJECT_TABS_STORAGE_KEY, ids)
}

/**
 * Hidden tab ids kept to existing workspaces, without the active one: the
 * project on screen always has a tab, so activating a project restores it.
 * Returns `hidden` itself when nothing changes.
 */
export function hiddenTabsAfterActivation(hidden: string[], workspaces: readonly Workspace[], activeId: string | undefined): string[] {
  const next = hidden.filter((id) => id !== activeId && workspaces.some((workspace) => workspace.id === id))
  return next.length === hidden.length ? hidden : next
}

export function projectTabs(workspaces: Workspace[], order: readonly string[] = [], hidden: readonly string[] = []): Workspace[] {
  const positions = new Map(order.map((id, index) => [id, index]))
  return workspaces.filter((workspace) => !hidden.includes(workspace.id)).sort((a, b) =>
    (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity) || a.createdAt - b.createdAt
  )
}

export function moveProjectTab(order: string[], sourceId: string, targetId: string, placement: 'before' | 'after'): string[] {
  if (sourceId === targetId || !order.includes(sourceId) || !order.includes(targetId)) return order
  const next = order.filter((id) => id !== sourceId)
  next.splice(next.indexOf(targetId) + (placement === 'after' ? 1 : 0), 0, sourceId)
  return next
}

export function sessionTabs(runtimes: Record<string, SessionRuntimeInfo>, workspaceId: string | undefined): SessionRuntimeInfo[] {
  // Newest runtime first; selecting a tab never changes its position.
  return Object.values(runtimes).filter((runtime) => runtime.workspaceId === workspaceId && runtime.sessionPath).reverse()
}

export function adjacentTabIndex(activeIndex: number, count: number, direction: 'previous' | 'next'): number | null {
  if (count === 0) return null
  if (activeIndex < 0) return direction === 'next' ? 0 : count - 1
  return (activeIndex + (direction === 'next' ? 1 : -1) + count) % count
}
