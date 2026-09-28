const POSIX_SEPARATOR = '/'
const WINDOWS_SEPARATOR = '\\'
const ANY_SEPARATOR_RE = /[\\/]/g
const TRAILING_SEPARATORS_RE = /[\\/]+$/

function toPosix(path: string): string {
  return path.replace(ANY_SEPARATOR_RE, POSIX_SEPARATOR)
}

/**
 * Map a repository-root-relative Git path onto the workspace. `gitPrefix` is
 * the workspace's directory inside its repository (`git rev-parse
 * --show-prefix`: '' at the root, else `pkg/app/`). Null when the path lies
 * outside the workspace; the match stops at a directory boundary, so
 * `pkg/app2/x` never maps into `pkg/app`.
 */
export function workspaceRelativeGitPath(repoPath: string, gitPrefix: string): string | null {
  const path = toPosix(repoPath)
  const prefix = toPosix(gitPrefix).replace(TRAILING_SEPARATORS_RE, '')
  if (!prefix) return path
  const directory = prefix + POSIX_SEPARATOR
  return path.startsWith(directory) ? path.slice(directory.length) : null
}

/** Absolute path of a workspace-relative `/` path, in the workspace path's own separator style. */
export function joinWorkspacePath(workspacePath: string, relativePath: string): string {
  const separator = workspacePath.includes(WINDOWS_SEPARATOR) ? WINDOWS_SEPARATOR : POSIX_SEPARATOR
  return workspacePath.replace(TRAILING_SEPARATORS_RE, '') + separator + relativePath.replace(ANY_SEPARATOR_RE, separator)
}
