import { isAbsolute, relative, resolve } from 'node:path'

/**
 * True when `candidate` resolves to `root` itself or a path nested inside it.
 * Uses a lexical `relative` comparison (resolving `..` first) so parent-traversal
 * escapes and sibling directories that merely share the root's string prefix
 * (e.g. `/a/project-secrets` vs `/a/project`) are rejected. Platform path rules
 * (case-insensitivity, separators, cross-drive on Windows) come from `path`.
 *
 * Lives under resources/ because the agent extensions load it at runtime next
 * to the main process, which imports the same file.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (resolvedCandidate === resolvedRoot) return true
  const rel = relative(resolvedRoot, resolvedCandidate)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}
