/**
 * Pure helpers for opening a dragged folder as a workspace.
 * Kept free of Electron/DOM globals so main, renderer, and tests share one path.
 *
 * Written for Chromium/Electron only: DataTransfer.types is a frozen string
 * array with a "Files" entry for OS file drags.
 */

/** Minimal shape of DataTransfer used by the drop helpers (no full DOM types). */
export interface FileDragTransfer {
  types: ArrayLike<string>
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
  if (!dataTransfer?.types) return false
  const types = dataTransfer.types
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true
  }
  return false
}

/**
 * Absolute path of the first directory in a drop, or null if none.
 *
 * Prefer directory entries via webkitGetAsEntry. When that returns null for an
 * item (some drag sources), fall back to getAsFile + getPathForFile and let
 * main confirm directory-ness via pathKind.
 */
export function firstDroppedFolderPath(
  dataTransfer: FileDragTransfer,
  getPathForFile: (file: File) => string
): string | null {
  const items = dataTransfer.items
  if (!items || items.length === 0) return null

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue

    const entry =
      typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null

    if (entry) {
      if (!entry.isDirectory) continue
      const file = item.getAsFile()
      if (!file) continue
      const p = getPathForFile(file)
      if (p) return p
      continue
    }

    // webkitGetAsEntry can return null; take the path and let main verify dir.
    const file = item.getAsFile()
    if (!file) continue
    const p = getPathForFile(file)
    if (p) return p
  }

  return null
}
