import { useTranslation } from 'react-i18next'

/**
 * A drag handle that reports movement along the requested axis as a delta.
 *
 * Shared by the chat panel's split panes and the sidebar. Reports deltas rather
 * than absolute positions so a caller can apply its own sign and clamping without
 * knowing where the handle sits on screen.
 */
export function ResizeHandle({
  onResize,
  onResizeEnd,
  axis = 'x',
}: {
  axis?: 'x' | 'y'
  onResize: (delta: number) => void
  /** Fires once when the drag ends — for callers that persist the final size. */
  onResizeEnd?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const handleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault()
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    let lastPosition = axis === 'x' ? event.clientX : event.clientY

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const position = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      onResize(position - lastPosition)
      lastPosition = position
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
      className={`relative z-20 shrink-0 ${axis === 'x' ? 'w-0' : 'h-0'}`}
      title={t('app.resizeHandle.title')}
    >
      <div className={axis === 'x'
        ? 'group absolute inset-y-0 -left-1 flex w-2 cursor-col-resize justify-center'
        : 'group absolute inset-x-0 -top-1 flex h-2 cursor-row-resize items-center'}>
        <div className={`${axis === 'x' ? 'w-px' : 'h-px w-full'} bg-transparent transition-colors group-hover:bg-accent`} />
      </div>
    </div>
  )
}
