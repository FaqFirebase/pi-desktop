import { useEffect, useRef, useState } from 'react'
import { droppedFolderCandidates, isFileDrag } from '../../../shared/folder-drop'
import { useAppStore } from '../store'

/**
 * Open the first candidate that is actually a directory. Entry-less items
 * (webkitGetAsEntry returned null) can only be classified by asking main, so
 * a file appearing before a folder in the drop must not end the search. When
 * nothing qualifies, the first candidate still goes through
 * openFolderAsWorkspace so its standard "not a folder" message surfaces.
 */
async function openFirstDroppedFolder(candidates: string[]): Promise<void> {
  for (const path of candidates) {
    try {
      const kind = await window.piDesktop.system.pathKind(path)
      if (kind.exists && kind.isDirectory) {
        await useAppStore.getState().openFolderAsWorkspace(path)
        return
      }
    } catch {
      // Unprobeable candidate — try the next one.
    }
  }
  await useAppStore.getState().openFolderAsWorkspace(candidates[0])
}

/**
 * Window-level folder drag-and-drop: drop a directory onto the app to open it
 * as a workspace (create if needed, switch, show Chat).
 *
 * The drop overlay is only shown while dragging — it dismisses immediately on
 * drop so the UI is not blocked while the workspace opens in the background.
 *
 * Files (non-directories) are ignored so future attachment drops can coexist.
 */
export function useFolderDrop(): {
  isDraggingFolder: boolean
} {
  const [isDraggingFolder, setIsDraggingFolder] = useState(false)
  const dragDepth = useRef(0)
  /** Prevent stacking concurrent openFolderAsWorkspace calls; no overlay. */
  const openInFlight = useRef(false)

  useEffect(() => {
    const clearDrag = (): void => {
      dragDepth.current = 0
      setIsDraggingFolder(false)
    }

    const onDragEnter = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return
      e.preventDefault()
      dragDepth.current += 1
      setIsDraggingFolder(true)
    }

    const onDragLeave = (): void => {
      // Depth only increments for file drags; leave just unwinds the counter.
      if (dragDepth.current === 0) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setIsDraggingFolder(false)
    }

    const onDragOver = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return
      e.preventDefault()
      // Dismiss overlay immediately — do not wait for workspace create/switch.
      clearDrag()
      if (!e.dataTransfer || openInFlight.current) return

      const candidates = droppedFolderCandidates(e.dataTransfer, (file) =>
        window.piDesktop.system.getPathForFile(file)
      )
      if (candidates.length === 0) return

      openInFlight.current = true
      void openFirstDroppedFolder(candidates).finally(() => {
        openInFlight.current = false
      })
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return { isDraggingFolder }
}
