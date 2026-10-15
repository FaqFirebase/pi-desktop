export const DEFAULT_TERMINAL_HEIGHT = 256
export const MIN_TERMINAL_HEIGHT = 120
export const MAX_TERMINAL_HEIGHT_RATIO = 0.8

export function clampTerminalHeight(height: number, availableHeight: number): number {
  const maximum = Math.max(0, availableHeight * MAX_TERMINAL_HEIGHT_RATIO)
  return Math.min(maximum, Math.max(MIN_TERMINAL_HEIGHT, height))
}
