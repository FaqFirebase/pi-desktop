/** `PerformanceNavigationTiming.type` of a page reload (the menu, the crash screen, a crash recovery). */
export const RELOAD_NAVIGATION_TYPE = 'reload'

/**
 * The first view after the renderer loads. A reload is not a launch: main kept
 * the workspace and session running, so the user returns to Chat.
 */
export function launchView(input: { openToHomeOnLaunch: boolean; navigationType: string | null }): 'home' | 'chat' {
  if (input.navigationType === RELOAD_NAVIGATION_TYPE) return 'chat'
  return input.openToHomeOnLaunch ? 'home' : 'chat'
}

export function currentNavigationType(): string | null {
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  return entry?.type ?? null
}
