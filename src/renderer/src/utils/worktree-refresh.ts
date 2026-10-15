import { WHOLE_WORKSPACE_CHANGE_PATH } from '../../../shared/ipc-contracts'

/** One edit on disk arrives as a burst of watcher events; reload once the burst settles. */
export const WORKTREE_DISK_CHANGE_DEBOUNCE_MS = 400

/**
 * Reload a view of the worktree (the diff, the Git action bar) when an agent
 * run ends or a branch switch replaces the worktree. While `watchDisk` holds
 * (the view is on screen), also reload once a burst of disk edits settles, so
 * edits made outside the app (a shell, another editor) show up without
 * Refresh. The watcher skips `.git`, but reports a HEAD or branch change (a
 * commit from a shell moves its branch) as a whole-worktree change.
 */
export function subscribeWorktreeRefresh(refresh: () => Promise<unknown>, watchDisk: boolean): () => void {
  let diskChangeTimer: ReturnType<typeof setTimeout> | null = null
  const stopAgentEvents = window.piDesktop.onEvent((event) => {
    if (event.type === 'agent_end') void refresh()
  })
  const stopFileChanges = window.piDesktop.onFileChange((event) => {
    if (event.relativePath === WHOLE_WORKSPACE_CHANGE_PATH) {
      void refresh()
      return
    }
    if (!watchDisk) return
    if (diskChangeTimer) clearTimeout(diskChangeTimer)
    diskChangeTimer = setTimeout(() => {
      diskChangeTimer = null
      void refresh()
    }, WORKTREE_DISK_CHANGE_DEBOUNCE_MS)
  })
  return () => {
    if (diskChangeTimer) clearTimeout(diskChangeTimer)
    stopAgentEvents()
    stopFileChanges()
  }
}
