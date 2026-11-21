import type { FileTreeNode } from '../../../shared/ipc-contracts'

/** Folder listings of the tree view, keyed by workspace-relative folder path ('' = the root). */
export type FolderListings = ReadonlyMap<string, FileTreeNode[]>

/**
 * Whether a folder is open. Top-level folders start open and deeper ones
 * closed; `toggled` holds the folders the user flipped from that default.
 */
export function isFolderExpanded(relativePath: string, toggled: ReadonlySet<string>): boolean {
  return !relativePath.includes('/') !== toggled.has(relativePath)
}

/**
 * List the root and every open folder reachable from it, one tree level at a
 * time (the folders of a level in parallel). `isExpanded` is read as each
 * level is reached, so a folder opened during the load is still listed when
 * its parent's level comes after it. A root failure throws (the workspace
 * folder is missing or unreadable); any other folder that cannot be listed
 * shows empty.
 */
export async function loadOpenFolders(
  listDir: (relativeDir: string) => Promise<FileTreeNode[]>,
  isExpanded: (relativePath: string) => boolean
): Promise<FolderListings> {
  const listings = new Map<string, FileTreeNode[]>()
  let level = ['']
  while (level.length > 0) {
    const listed = await Promise.all(
      level.map((dir) => (dir ? listDir(dir).catch((): FileTreeNode[] => []) : listDir(dir)))
    )
    const next: string[] = []
    level.forEach((dir, index) => {
      listings.set(dir, listed[index])
      for (const entry of listed[index]) {
        if (entry.type === 'directory' && isExpanded(entry.relativePath)) next.push(entry.relativePath)
      }
    })
    level = next
  }
  return listings
}
