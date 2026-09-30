import type { SessionRuntimeInfo, Workspace } from '../../../shared/ipc-contracts'

export function projectTabs(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => a.createdAt - b.createdAt)
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
