import type { ChatImportListItem } from '../../../shared/chat-import'
import { pathGroupKey } from '../../../shared/path-compare'

/** Chats of one project folder in the import list. */
export interface ChatImportGroup {
  cwd: string | null
  items: ChatImportListItem[]
  latestModifiedAt: number
}

/** A chat can be ticked only when its project folder still exists. */
export function isSelectableChat(item: ChatImportListItem): boolean {
  return item.cwd !== null && item.cwdExists
}

/** Groups by cwd (platform-aware key from pathGroupKey), newest group first, newest item first; a null cwd is its own group, last. */
export function groupChatImportItems(items: readonly ChatImportListItem[]): ChatImportGroup[] {
  const groups = new Map<string | null, ChatImportGroup>()
  for (const item of items) {
    const key = item.cwd === null ? null : pathGroupKey(item.cwd)
    const group = groups.get(key)
    if (group) {
      group.items.push(item)
      group.latestModifiedAt = Math.max(group.latestModifiedAt, item.modifiedAt)
    } else {
      groups.set(key, { cwd: item.cwd, items: [item], latestModifiedAt: item.modifiedAt })
    }
  }
  for (const group of groups.values()) group.items.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return [...groups.values()].sort((a, b) => {
    if ((a.cwd === null) !== (b.cwd === null)) return a.cwd === null ? 1 : -1
    return b.latestModifiedAt - a.latestModifiedAt
  })
}

/** New selection after a group checkbox click: all selectable items on, or all off when all were on. */
export function toggleGroupSelection(selected: ReadonlySet<string>, group: ChatImportGroup): Set<string> {
  const paths = group.items.filter(isSelectableChat).map((item) => item.sourcePath)
  const next = new Set(selected)
  const allSelected = paths.every((path) => next.has(path))
  for (const path of paths) {
    if (allSelected) next.delete(path)
    else next.add(path)
  }
  return next
}
