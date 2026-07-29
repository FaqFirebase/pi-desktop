/**
 * Platform-aware path comparison shared by main and renderer.
 * Case-insensitive only on win32 (matches session-paths.pathsEqual).
 */

function defaultCaseInsensitive(): boolean {
  try {
    return typeof process !== 'undefined' && process.platform === 'win32'
  } catch {
    return false
  }
}

/** Strip a single trailing slash/backslash for stable equality. */
function stripTrailingSep(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/**
 * Whether two filesystem paths refer to the same location.
 * Optional `caseInsensitive` override is for tests.
 */
export function pathsEqual(
  a: string,
  b: string,
  caseInsensitive: boolean = defaultCaseInsensitive()
): boolean {
  const na = stripTrailingSep(a)
  const nb = stripTrailingSep(b)
  return caseInsensitive ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/**
 * Stable map/group key for a path (case-fold only when pathsEqual does).
 */
export function pathGroupKey(
  path: string,
  caseInsensitive: boolean = defaultCaseInsensitive()
): string {
  const n = stripTrailingSep(path)
  return caseInsensitive ? n.toLowerCase() : n
}
