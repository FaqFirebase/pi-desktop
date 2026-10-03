/** Keep each patch intact, removing only blank separators between files. */
export function splitGitDiff(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m)
    .filter((patch) => patch.startsWith('diff --git '))
    .map((patch) => patch.replace(/\n+$/, '') + '\n')
}

/** Quoted/escaped Git paths are not safe to act on without decoding them. */
export function gitDiffPaths(patch: string): { oldPath: string; newPath: string } | null {
  const match = patch.split('\n', 1)[0].match(/^diff --git a\/(.+?) b\/(.+)$/)
  return match ? { oldPath: match[1], newPath: match[2] } : null
}

/**
 * Git prints paths from the repository root even when run from a subdirectory.
 * `prefix` is the workspace's own directory inside the repository
 * (`git rev-parse --show-prefix`, '' at the root), so a path outside the
 * workspace comes back with leading `../` segments.
 */
export function workspaceRelativeGitPath(path: string, prefix: string): string {
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  return '../'.repeat(prefix.split('/').filter(Boolean).length) + path
}

export function canDiscardGitPatch(patch: string): boolean {
  return gitDiffPaths(patch) !== null
    && !patch.includes('\0')
    && !/^Binary files |^GIT binary patch$|^.*mode (120000|160000)$/m.test(patch)
}
