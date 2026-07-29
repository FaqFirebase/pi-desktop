/**
 * Platform-aware path comparison shared by main and renderer.
 * Case-insensitive only on win32.
 *
 * Renderer note: sandboxed pages (`nodeIntegration: false`) have no Node
 * `process` global. The preload bridge exposes `piDesktop.system.platform`
 * (from the preload's process polyfill) so this helper still detects Windows.
 */

function readBridgedPlatform(): string | undefined {
  try {
    const g = globalThis as {
      piDesktop?: { system?: { platform?: string } }
    }
    const bridged = g.piDesktop?.system?.platform
    return typeof bridged === 'string' ? bridged : undefined
  } catch {
    return undefined
  }
}

function readNodePlatform(): string | undefined {
  try {
    if (typeof process !== 'undefined' && typeof process.platform === 'string') {
      return process.platform
    }
  } catch {
    // ignore
  }
  return undefined
}

/**
 * Resolve whether path comparisons should fold case.
 * Order: explicit override (tests) → bridged platform (renderer) → Node process (main).
 */
export function isPathCaseInsensitive(
  caseInsensitive?: boolean
): boolean {
  if (typeof caseInsensitive === 'boolean') return caseInsensitive
  const platform = readBridgedPlatform() ?? readNodePlatform()
  return platform === 'win32'
}

/** Strip trailing slash/backslash for stable equality. */
function stripTrailingSep(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/**
 * Whether two filesystem paths refer to the same location.
 * Optional `caseInsensitive` override is for tests and callers that already
 * know the target filesystem semantics.
 */
export function pathsEqual(
  a: string,
  b: string,
  caseInsensitive?: boolean
): boolean {
  const fold = isPathCaseInsensitive(caseInsensitive)
  const na = stripTrailingSep(a)
  const nb = stripTrailingSep(b)
  return fold ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/**
 * Stable map/group key for a path (case-fold only when pathsEqual does).
 */
export function pathGroupKey(
  path: string,
  caseInsensitive?: boolean
): string {
  const fold = isPathCaseInsensitive(caseInsensitive)
  const n = stripTrailingSep(path)
  return fold ? n.toLowerCase() : n
}
