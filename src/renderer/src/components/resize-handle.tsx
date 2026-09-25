import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
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
      className="relative z-20 w-0 shrink-0"
      title={t('app.resizeHandle.title')}
    >
      <div className="group absolute inset-y-0 -left-1 flex w-2 cursor-col-resize justify-center">
        <div className="w-px bg-transparent transition-colors group-hover:bg-accent" />
      </div>
    </div>
  )
}
