export interface WindowRectangle {
  x: number
  y: number
  width: number
  height: number
}

interface PreferredLength {
  share: number
  min: number
  max: number
}

/** The default popup takes a share of the work area, kept between a floor and a ceiling. */
const PREFERRED_WIDTH: PreferredLength = { share: 0.42, min: 640, max: 960 }
const PREFERRED_HEIGHT: PreferredLength = { share: 0.55, min: 420, max: 720 }
/** The default popup sits a third of the way down, above the visual center. */
const VERTICAL_PLACEMENT_DIVISOR = 3

export function sameRectangle(a: WindowRectangle, b: WindowRectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
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

function preferredLength(available: number, preferred: PreferredLength): number {
  return Math.round(Math.min(Math.max(preferred.min, available * preferred.share), preferred.max, available))
}

export function adaptiveQuickChatSize(workArea: WindowRectangle): { width: number; height: number } {
  return {
    width: preferredLength(workArea.width, PREFERRED_WIDTH),
    height: preferredLength(workArea.height, PREFERRED_HEIGHT),
  }
}

export function positionQuickChatBounds(size: { width: number; height: number }, workArea: WindowRectangle): WindowRectangle {
  return clampQuickChatBounds({
    ...size,
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / VERTICAL_PLACEMENT_DIVISOR),
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
