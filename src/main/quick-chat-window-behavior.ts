export interface WindowRectangle {
  x: number
  y: number
  width: number
  height: number
}

/** Work-area coordinates are already in Electron's device-independent pixels. */
export function clampQuickChatBounds(bounds: WindowRectangle, workArea: WindowRectangle): WindowRectangle {
  const width = Math.min(Math.max(1, bounds.width), workArea.width)
  const height = Math.min(Math.max(1, bounds.height), workArea.height)
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
  }
}
export function adaptiveQuickChatSize(workArea: WindowRectangle): { width: number; height: number } {
  return {
    width: Math.round(Math.min(Math.max(640, workArea.width * 0.42), 960, workArea.width)),
    height: Math.round(Math.min(Math.max(420, workArea.height * 0.55), 720, workArea.height)),
  }
}


export function positionQuickChatBounds(size: { width: number; height: number }, workArea: WindowRectangle): WindowRectangle {
  return clampQuickChatBounds({
    ...size,
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 3),
  }, workArea)
}

export function resolveQuickChatBounds(input: {
  currentBounds: WindowRectangle
  lastCustomBounds: WindowRectangle | null
  userPositioned: boolean
  workArea: WindowRectangle
}): WindowRectangle {
  if (input.userPositioned) {
    return clampQuickChatBounds(input.lastCustomBounds ?? input.currentBounds, input.workArea)
  }
  return positionQuickChatBounds(adaptiveQuickChatSize(input.workArea), input.workArea)
}

/** Native child dialogs and IME/menu focus transfers are not outside clicks. */
export function shouldHideQuickChatOnBlur(input: {
  visible: boolean
  focused: boolean
  ownedInteraction: boolean
  composing: boolean
  applicationDeactivated: boolean
  pinned?: boolean
}): boolean {
  if (input.pinned) return false
  return input.visible && (input.applicationDeactivated || (!input.focused && !input.ownedInteraction && !input.composing))
}
