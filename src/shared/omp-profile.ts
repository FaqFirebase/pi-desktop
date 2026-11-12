/**
 * OMP named profiles (`omp --profile <name>`, or the `OMP_PROFILE` environment
 * variable) keep separate logins, sessions, settings and plugins under
 * `~/.omp/profiles/<name>`. The default profile is the plain `~/.omp` tree and
 * is represented as `undefined` in the app.
 *
 * The name rule mirrors OMP's own (`normalizeProfileName` in pi-utils), so the
 * app reads exactly the directory OMP uses. The name also becomes a path
 * segment, which this rule keeps safe: it cannot contain a separator or name
 * `.`/`..`.
 */

/** The name OMP reads as "the default profile". */
export const DEFAULT_OMP_PROFILE_NAME = 'default'

/** Longest profile name OMP accepts. */
export const MAX_OMP_PROFILE_NAME_LENGTH = 64

const OMP_PROFILE_NAME_PATTERN = new RegExp(`^[a-z0-9][a-z0-9._-]{0,${MAX_OMP_PROFILE_NAME_LENGTH - 1}}$`)

// Windows refuses these as file names whatever the extension, so OMP refuses
// them as profile names on every platform.
const WINDOWS_RESERVED_BASENAME_PATTERN = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i

/** True when `name` is a named (non-default) profile OMP would accept. */
export function isValidOmpProfileName(name: string): boolean {
  return (
    OMP_PROFILE_NAME_PATTERN.test(name) &&
    !name.endsWith('.') &&
    !WINDOWS_RESERVED_BASENAME_PATTERN.test(name)
  )
}

/**
 * Normalize a profile value:
 * - `undefined`: the default profile (missing, empty, whitespace, or `default`)
 * - a string: a valid named profile, trimmed
 * - `null`: a name OMP would refuse
 */
export function normalizeOmpProfile(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === DEFAULT_OMP_PROFILE_NAME) return undefined
  return isValidOmpProfileName(trimmed) ? trimmed : null
}
