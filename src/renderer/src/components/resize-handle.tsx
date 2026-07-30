/**
 * A vertical drag handle that reports horizontal movement as a delta.
 *
 * Shared by the chat panel's split panes and the sidebar. Reports deltas rather
 * than absolute positions so a caller can apply its own sign and clamping without
 * knowing where the handle sits on screen.
 */
export function ResizeHandle({
  onResize,
  onResizeEnd,
}: {
  onResize: (delta: number) => void
  /** Fires once when the drag ends — for callers that persist the final size. */
  onResizeEnd?: () => void
}): React.JSX.Element {
  const handleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault()
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    let lastX = event.clientX

    const handleMouseMove = (moveEvent: MouseEvent) => {
      onResize(moveEvent.clientX - lastX)
      lastX = moveEvent.clientX
    }

    const handleMouseUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      onResizeEnd?.()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      className="group flex w-2 shrink-0 cursor-col-resize items-stretch justify-center bg-app transition-colors hover:bg-surface-hover"
      title="Drag to resize"
    >
      <div className="w-px bg-transparent transition-colors group-hover:bg-accent" />
    </div>
  )
}
