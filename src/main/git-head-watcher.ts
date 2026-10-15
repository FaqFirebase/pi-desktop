import { watch, type FSWatcher } from 'fs'
import { join, resolve } from 'path'
import { runGit } from './git-worktree'

/** A checkout rewrites HEAD through a lock file; report once the burst settles. */
export const GIT_HEAD_CHANGE_DEBOUNCE_MS = 300

const HEAD_FILE_NAME = 'HEAD'
const PACKED_REFS_FILE_NAME = 'packed-refs'
const LOCAL_BRANCHES_DIR = join('refs', 'heads')

/**
 * Call `onChange` when the checkout's HEAD or the local branch list changes:
 * a branch switch, a detached checkout, or a branch created, deleted or
 * committed to outside the app (a terminal, another tool). The workspace file
 * watcher skips `.git`, so without this the branch shown in the app stays
 * stale until some other file changes.
 *
 * The HEAD file of a linked worktree lives in its own git directory, which
 * `--absolute-git-dir` names; the branches live in the common git directory,
 * shared by every worktree. Directories are watched instead of files: Git
 * replaces a ref by renaming a lock file over it, which ends a watch on the
 * old file. Branch names may hold slashes, so `refs/heads` is watched
 * recursively. Outside a repository nothing is watched. Returns the stop
 * function.
 */
export function watchGitHead(cwd: string, onChange: () => void): () => void {
  let stopped = false
  const watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const report = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!stopped) onChange()
    }, GIT_HEAD_CHANGE_DEBOUNCE_MS)
  }
  const watchDirectory = (dir: string, recursive: boolean, isRelevant: (fileName: string) => boolean): void => {
    let watcher: FSWatcher
    try {
      watcher = watch(dir, { persistent: false, recursive }, (_event, fileName) => {
        // Some platforms omit the name; a spare refresh is harmless.
        if (!fileName || isRelevant(fileName)) report()
      })
    } catch {
      // A missing directory (a ref store without loose refs) has nothing to report.
      return
    }
    // A removed git directory ends the watch; the next workspace watch starts a new one.
    watcher.on('error', () => watcher.close())
    watchers.push(watcher)
  }
  void runGit(['rev-parse', '--absolute-git-dir', '--git-common-dir'], cwd).then(({ stdout }) => {
    if (stopped) return
    const [gitDirRaw, commonDirRaw] = stdout.trim().split('\n')
    const gitDir = resolve(gitDirRaw)
    const commonDir = resolve(cwd, commonDirRaw)
    const namesByDir = new Map<string, Set<string>>([[gitDir, new Set([HEAD_FILE_NAME])]])
    const commonDirNames = namesByDir.get(commonDir) ?? new Set<string>()
    commonDirNames.add(PACKED_REFS_FILE_NAME)
    namesByDir.set(commonDir, commonDirNames)
    for (const [dir, names] of namesByDir) watchDirectory(dir, false, (fileName) => names.has(fileName))
    watchDirectory(join(commonDir, LOCAL_BRANCHES_DIR), true, () => true)
  }, () => {})
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    for (const watcher of watchers.splice(0)) watcher.close()
  }
}
