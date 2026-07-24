import { isAbsolute, relative, resolve } from 'path'

/**
 * True when `candidate` resolves to `root` itself or a path nested inside it.
 * Uses a lexical `relative` comparison (resolving `..` first) so parent-traversal
 * escapes and sibling directories that merely share the root's string prefix
 * (e.g. `/a/project-secrets` vs `/a/project`) are rejected. Platform path rules
 * (case-insensitivity, separators, cross-drive on Windows) come from `path`.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (resolvedCandidate === resolvedRoot) return true
  const rel = relative(resolvedRoot, resolvedCandidate)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Authorize a path for the attachment reader. A path is allowed only if the user
 * picked it through the native open dialog (tracked in `approvedPaths`, stored
 * pre-resolved) or it lives inside the active workspace. This keeps a compromised
 * renderer from reading arbitrary files (e.g. `~/.ssh/id_rsa`) via the reader.
 */
export function isAuthorizedAttachmentPath(
  candidate: string,
  opts: { workspaceRoot: string | null; approvedPaths: ReadonlySet<string> }
): boolean {
  const resolved = resolve(candidate)
  if (opts.approvedPaths.has(resolved)) return true
  return opts.workspaceRoot ? isPathWithin(opts.workspaceRoot, resolved) : false
}
