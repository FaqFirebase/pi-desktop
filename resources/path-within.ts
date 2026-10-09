import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix, win32 } from 'node:path'

/**
 * True when `candidate` resolves to `root` itself or a path nested inside it.
 * Uses a lexical `relative` comparison (resolving `..` first) so parent-traversal
 * escapes and sibling directories that merely share the root's string prefix
 * (e.g. `/a/project-secrets` vs `/a/project`) are rejected. Platform path rules
 * (case-insensitivity, separators, cross-drive on Windows) come from `path`
 * for `platform`, the current one unless a test names another.
 *
 * Lives under resources/ because the agent extensions load it at runtime next
 * to the main process, which imports the same file.
 */
export function isPathWithin(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const { isAbsolute, relative, resolve } = platform === 'win32' ? win32 : posix
  // An empty relative path is the root itself, by the platform's own
  // comparison (on Windows `c:\repo` is `C:\Repo`).
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// A part of the path does not exist (ENOTDIR: a file where a folder should be).
const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR'])

/**
 * True when a file system error says a part of the path is missing, false for
 * any other file system error. Anything else is not expected and is rethrown.
 */
function isMissingPathError(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
  if (typeof code !== 'string') throw error
  return MISSING_PATH_CODES.has(code)
}

/**
 * The real path of the absolute `path`, whose last parts may not exist yet:
 * the symlinks in the part that exists are followed and the missing rest is
 * kept as written. Null when the real location cannot be known: a dangling
 * symlink on the way (a write through it creates its target, wherever that
 * is), a symlink loop, or a folder the process may not read.
 */
export function resolveRealPath(path: string): string | null {
  const missingParts: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync(current), ...missingParts)
    } catch (error) {
      if (!isMissingPathError(error)) return null
    }
    try {
      if (lstatSync(current).isSymbolicLink()) return null
    } catch (error) {
      if (!isMissingPathError(error)) return null
    }
    const parent = dirname(current)
    if (parent === current) return null
    missingParts.unshift(basename(current))
    current = parent
  }
}
