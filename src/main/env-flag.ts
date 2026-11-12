/**
 * Environment flags a host sets to switch an option on: `1`, `true`, `yes` or
 * `on` (any case, surrounding spaces ignored). Anything else, or unset, is off.
 */
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on'])

export function isEnvFlagOn(value: string | undefined): boolean {
  return typeof value === 'string' && ENABLED_VALUES.has(value.trim().toLowerCase())
}
