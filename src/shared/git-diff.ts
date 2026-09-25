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

export function canDiscardGitPatch(patch: string): boolean {
  return gitDiffPaths(patch) !== null
    && !patch.includes('\0')
    && !/^Binary files |^GIT binary patch$|^.*mode (120000|160000)$/m.test(patch)
}
