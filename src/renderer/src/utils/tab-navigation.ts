import type { SessionRuntimeInfo, Workspace } from '../../../shared/ipc-contracts'

export const PROJECT_TAB_ORDER_STORAGE_KEY = 'pi-desktop.project-tab-order'

export function readProjectTabOrder(): string[] {
  try {
    const order: unknown = JSON.parse(localStorage.getItem(PROJECT_TAB_ORDER_STORAGE_KEY) ?? '[]')
    return Array.isArray(order) && order.every((id) => typeof id === 'string') ? [...new Set(order)] : []
  } catch {
    // Missing/unavailable storage or a damaged preference uses creation order.
    return []
  }
}

export function rememberProjectTabOrder(order: string[]): void {
  try {
    localStorage.setItem(PROJECT_TAB_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Reordering still works for this window when storage is unavailable.
  }
}

export function projectTabs(workspaces: Workspace[], order: readonly string[] = []): Workspace[] {
  const positions = new Map(order.map((id, index) => [id, index]))
  return [...workspaces].sort((a, b) =>
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
