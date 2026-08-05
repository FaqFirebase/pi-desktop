/**
 * Pure helpers for opening a dragged folder as a workspace.
 * Kept free of Electron/DOM globals so main, renderer, and tests share one path.
 */

/** Minimal shape of DataTransfer used by the drop helpers (no full DOM types). */
export interface FileDragTransfer {
  types: ArrayLike<string> | { contains?: (type: string) => boolean; [i: number]: string; length: number }
  files: ArrayLike<{ name?: string }>
  items?: ArrayLike<FileDragItem> | null
}

export interface FileDragItem {
  kind: string
  webkitGetAsEntry?: () => { isDirectory: boolean; isFile: boolean } | null
  getAsFile: () => File | null
}

/** Display name for a workspace created from a folder path. */
export function workspaceNameFromFolderPath(folderPath: string): string {
  const name = folderPath.split(/[\\/]/).filter(Boolean).pop()
  return name && name.length > 0 ? name : folderPath
}

/**
 * Whether a DataTransfer looks like an OS file/folder drag (not internal
 * text/HTML drags). Used to decide when to show the drop overlay and accept drops.
 */
export function isFileDrag(dataTransfer: FileDragTransfer | null | undefined): boolean {
  if (!dataTransfer) return false
  const types = dataTransfer.types
  if (types && typeof (types as { contains?: (t: string) => boolean }).contains === 'function') {
    if ((types as { contains: (t: string) => boolean }).contains('Files')) return true
  }
  if (types && typeof (types as ArrayLike<string>).length === 'number') {
    for (let i = 0; i < (types as ArrayLike<string>).length; i++) {
      if ((types as ArrayLike<string>)[i] === 'Files') return true
    }
  }
  return dataTransfer.files.length > 0
}

/**
 * Prefer directory entries from a drop. When webkitGetAsEntry is available,
 * only directory entries are kept. Falls back to all File objects (caller must
 * verify isDirectory via main) when entry API is missing.
 */
export function collectDroppedPaths(
  dataTransfer: FileDragTransfer,
  getPathForFile: (file: File) => string
): { paths: string[]; hadNonDirectoryEntry: boolean } {
  const paths: string[] = []
  const seen = new Set<string>()
  let hadNonDirectoryEntry = false

  const items = dataTransfer.items
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind !== 'file') continue
      const entry =
        typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      if (entry) {
        if (entry.isDirectory) {
          const file = item.getAsFile()
          if (!file) continue
          const p = getPathForFile(file)
          if (p && !seen.has(p)) {
            seen.add(p)
            paths.push(p)
          }
        } else if (entry.isFile) {
          hadNonDirectoryEntry = true
        }
        continue
      }
      // No entry API — take the file and let main confirm directory-ness.
      const file = item.getAsFile()
      if (!file) continue
      const p = getPathForFile(file)
      if (p && !seen.has(p)) {
        seen.add(p)
        paths.push(p)
      }
    }
    return { paths, hadNonDirectoryEntry }
  }

  for (let i = 0; i < dataTransfer.files.length; i++) {
    const file = dataTransfer.files[i] as File
    const p = getPathForFile(file)
    if (p && !seen.has(p)) {
      seen.add(p)
      paths.push(p)
    }
  }
  return { paths, hadNonDirectoryEntry }
}
