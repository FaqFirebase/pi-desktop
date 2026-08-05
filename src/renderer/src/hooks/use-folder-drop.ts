import { useCallback, useEffect, useRef, useState } from 'react'
import { collectDroppedPaths, isFileDrag } from '../../../shared/folder-drop'
import { useAppStore } from '../store'

/**
 * Window-level folder drag-and-drop: drop a directory onto the app to open it
 * as a workspace (create if needed, switch, show Chat).
 *
 * Files (non-directories) are ignored so future attachment drops can coexist.
 */
export function useFolderDrop(): {
  isDraggingFolder: boolean
  dropBusy: boolean
} {
  const [isDraggingFolder, setIsDraggingFolder] = useState(false)
  const [dropBusy, setDropBusy] = useState(false)
  const dragDepth = useRef(0)
  const busyRef = useRef(false)

  const clearDrag = useCallback((): void => {
    dragDepth.current = 0
    setIsDraggingFolder(false)
  }, [])

  useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return
      e.preventDefault()
      dragDepth.current += 1
      setIsDraggingFolder(true)
    }

    const onDragLeave = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer) && dragDepth.current === 0) return
      e.preventDefault()
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
      e.stopPropagation()
      clearDrag()
      if (!e.dataTransfer || busyRef.current) return

      const { paths } = collectDroppedPaths(e.dataTransfer, (file) =>
        window.piDesktop.system.getPathForFile(file)
      )
      if (paths.length === 0) return

      // One folder per drop — multi-folder would stack ambiguous switches.
      const folderPath = paths[0]
      busyRef.current = true
      setDropBusy(true)
      void useAppStore
        .getState()
        .openFolderAsWorkspace(folderPath)
        .finally(() => {
          busyRef.current = false
          setDropBusy(false)
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
  }, [clearDrag])

  return { isDraggingFolder, dropBusy }
}
