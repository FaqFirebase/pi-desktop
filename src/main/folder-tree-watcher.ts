import { watch, type Dirent, type FSWatcher } from 'fs'
import { lstat, readdir } from 'fs/promises'
import { join } from 'path'

const ROOT_FOLDER = ''
const ROOT_DEPTH = 0
const TREE_PATH_SEPARATOR = '/'
const RENAME_EVENT = 'rename'

export interface FolderTreeWatchOptions {
  /** Deepest folder level that gets a watch; the root is level 0. */
  maxDepth: number
  /** True when a workspace-relative path (`/` separators) must be skipped with all it holds. */
  isIgnored: (relativePath: string) => boolean
  /** Called with the workspace-relative path of each entry made, changed or removed. */
  onChange: (relativePath: string) => void
  onError: (error: unknown) => void
}

export interface FolderTreeWatch {
  /** Settles once every folder in reach at the start has a watch. */
  ready: Promise<void>
  close: () => void
}

function childTreePath(folder: string, name: string): string {
  return folder === ROOT_FOLDER ? name : `${folder}${TREE_PATH_SEPARATOR}${name}`
}

function isSameOrInside(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}${TREE_PATH_SEPARATOR}`)
}

/**
 * Watch a folder tree with one non-recursive `fs.watch` per folder. On Linux a
 * folder watch already reports every entry in it that is made, changed or
 * removed, so files get no watch of their own: a home folder needs about
 * 10,000 watches instead of 260,000, and the start never blocks the event
 * loop for long. The walk does not follow symlinks (a link is never a
 * `Dirent` directory). A folder made later gets its watch from the rename
 * event of its parent; a removed folder loses its watch and the watches
 * below it the same way.
 */
export function watchFolderTree(root: string, options: FolderTreeWatchOptions): FolderTreeWatch {
  const { maxDepth, isIgnored, onChange, onError } = options
  const watchers = new Map<string, FSWatcher>()
  let closed = false

  const unwatch = (folder: string): void => {
    for (const [path, watcher] of watchers) {
      if (!isSameOrInside(folder, path)) continue
      watcher.close()
      watchers.delete(path)
    }
  }

  // A rename event means the entry was made, removed or replaced, so a watch
  // on the old folder of that name is stale either way.
  const followRename = async (folder: string, depth: number): Promise<void> => {
    let isFolder: boolean
    try {
      isFolder = (await lstat(join(root, folder))).isDirectory()
    } catch {
      // Gone, or no longer readable.
      isFolder = false
    }
    if (closed) return
    unwatch(folder)
    if (isFolder) await addFolder(folder, depth)
  }

  const onEntryEvent = (folder: string, depth: number, event: string, name: string | null): void => {
    // No name: the event names no entry, so report the folder itself.
    if (name === null) {
      onChange(folder)
      return
    }
    const entry = childTreePath(folder, name)
    if (isIgnored(entry)) return
    onChange(entry)
    if (event === RENAME_EVENT && depth < maxDepth) void followRename(entry, depth + 1)
  }

  const addFolder = async (folder: string, depth: number): Promise<void> => {
    if (closed || watchers.has(folder)) return
    const absolute = join(root, folder)
    try {
      const watcher = watch(absolute, { persistent: true }, (event, name) => onEntryEvent(folder, depth, event, name))
      watcher.on('error', (error) => {
        unwatch(folder)
        onError(error)
      })
      watchers.set(folder, watcher)
    } catch (error) {
      onError(error)
      return
    }
    if (depth === maxDepth) return
    let entries: Dirent[]
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      onError(error)
      return
    }
    for (const entry of entries) {
      const child = childTreePath(folder, entry.name)
      if (entry.isDirectory() && !isIgnored(child)) await addFolder(child, depth + 1)
    }
  }

  return {
    ready: addFolder(ROOT_FOLDER, ROOT_DEPTH),
    close: () => {
      closed = true
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
