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
 * Absolute paths that could be the dropped folder, in confidence order:
 * confirmed directory entries first, then items whose kind is unknown because
 * webkitGetAsEntry returned null (some drag sources). Confirmed plain files
 * are excluded, and an unknown never shadows a confirmed folder behind it.
 * The caller probes each candidate (main-side pathKind) and opens the first
 * directory.
 */
export function droppedFolderCandidates(
  dataTransfer: FileDragTransfer,
  getPathForFile: (file: File) => string
): string[] {
  const items = dataTransfer.items
  if (!items || items.length === 0) return []

  const directories: string[] = []
  const unknowns: string[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue

    const entry =
      typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry && !entry.isDirectory) continue

    const file = item.getAsFile()
    if (!file) continue
    const p = getPathForFile(file)
    if (!p) continue
    ;(entry ? directories : unknowns).push(p)
  }

  return [...directories, ...unknowns]
}
