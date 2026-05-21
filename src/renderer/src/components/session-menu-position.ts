export interface MenuPosition {
  x: number
  y: number
}

export interface MenuPositionOptions {
  triggerRect: Pick<DOMRect, 'left' | 'right' | 'bottom'>
  menuWidth: number
  menuHeight: number
  viewportWidth: number
  viewportHeight: number
  padding?: number
  offset?: number
}

export function getSessionMenuPosition({
  triggerRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  padding = 8,
  offset = 6,
}: MenuPositionOptions): MenuPosition {
  const maxX = Math.max(padding, viewportWidth - menuWidth - padding)
  const maxY = Math.max(padding, viewportHeight - menuHeight - padding)
  const preferredX = triggerRect.right - menuWidth
  const preferredY = triggerRect.bottom + offset

  return {
    x: Math.min(Math.max(preferredX, padding), maxX),
    y: Math.min(Math.max(preferredY, padding), maxY),
  }
}
