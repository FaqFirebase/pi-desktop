/**
 * When Pi Desktop stops idle sleep. 'while-working' holds only while agent
 * work runs; 'always' holds for as long as the app runs.
 */
export type KeepAwakeMode = 'off' | 'while-working' | 'always'

export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ['off', 'while-working', 'always']

export const DEFAULT_KEEP_AWAKE_MODE: KeepAwakeMode = 'off'

export function isKeepAwakeMode(value: unknown): value is KeepAwakeMode {
  return typeof value === 'string' && (KEEP_AWAKE_MODES as readonly string[]).includes(value)
}

/**
 * What the keep-awake setting does now. `unsupported` means a mode is on but
 * no layer could block sleep on this system.
 */
export type KeepAwakeStatus = 'off' | 'holding' | 'waiting-for-work' | 'unsupported'
