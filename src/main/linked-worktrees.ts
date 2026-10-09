import type { LinkedTaskMode, LinkedTaskRepo, RepoSetMember } from '../shared/ipc-contracts'
import { t, tEnglish, type Translate } from '../shared/i18n'
import { appLog } from './app-log'
import {
  createGitWorktree,
  deleteMergedBranch,
  describeGitFailure,
  GitCommandError,
  inspectGitRepository,
  removeGitWorktree,
  slugifyWorktreePart,
  worktreeTargetPath,
} from './git-worktree'

export interface LinkedCheckoutOptions {
  mode: LinkedTaskMode
  /** Workspace id of the task; it keeps every worktree path unique. */
  taskId: string
  /** Shared branch of an isolated task; ignored in place. */
  branch: string
  /** Root folder of the app's managed worktrees. */
  worktreesDir: string
}

/** Git failures in `translate`'s language: the interface's for the user, English for the log. */
function failureDetail(error: unknown, translate: Translate): string {
  return error instanceof GitCommandError
    ? describeGitFailure(error.args, error.stdout, error.stderr, translate)
    : error instanceof Error ? error.message : String(error)
}

/**
 * Give one member its checkout for the task. Isolated: a new worktree on the
 * task's branch, started from the member's HEAD. In place: the member's own
 * checkout on whatever branch it has, never removed by the app.
 */
export async function checkoutForLinkedTask(member: RepoSetMember, options: LinkedCheckoutOptions): Promise<LinkedTaskRepo> {
  const git = await inspectGitRepository(member.sourcePath)
  const shared = { name: member.name, role: member.role, sourcePath: member.sourcePath, repoRoot: git.repoRoot }
  if (options.mode === 'inPlace') {
    return { ...shared, workPath: member.sourcePath, branch: git.branch, managed: false }
  }
  // The member name is unique in the set, so two repositories with the same
  // folder name still get separate worktree paths.
  const workPath = worktreeTargetPath(options.worktreesDir, git.repoRoot, `${options.taskId}-${slugifyWorktreePart(member.name)}`)
  await createGitWorktree({ sourceCwd: member.sourcePath, targetPath: workPath, branch: options.branch })
  const sourceWasDirty = git.status.trim().length > 0
  return { ...shared, workPath, branch: options.branch, baseRef: git.head, managed: true, ...(sourceWasDirty ? { sourceWasDirty } : {}) }
}

/**
 * Undo checkouts made for a task that could not start. The worktrees are new
 * and hold no work, and their branches point at the source HEAD, so a safe
 * `branch -d` removes them too. Failures are logged and skipped.
 */
async function discardNewCheckouts(repos: readonly LinkedTaskRepo[]): Promise<void> {
  for (const repo of repos) {
    if (!repo.managed || !repo.branch) continue
    try {
      await removeGitWorktree(repo.repoRoot, repo.workPath)
      await deleteMergedBranch(repo.repoRoot, repo.branch)
    } catch (error) {
      appLog.warn('linked-task', 'Could not undo a worktree of a task that failed to start', failureDetail(error, tEnglish))
    }
  }
}

/**
 * Checkouts for every member, in set order. When one fails, the ones already
 * made are undone and the error names the repository that failed.
 */
export async function checkoutLinkedTask(
  members: readonly RepoSetMember[],
  options: LinkedCheckoutOptions,
): Promise<LinkedTaskRepo[]> {
  const repos: LinkedTaskRepo[] = []
  for (const member of members) {
    try {
      repos.push(await checkoutForLinkedTask(member, options))
    } catch (error) {
      await discardNewCheckouts(repos)
      throw new Error(t('repoSets.errors.checkoutFailed', { name: member.name, detail: failureDetail(error, t) }), { cause: error })
    }
  }
  return repos
}

/**
 * Remove the clean managed worktrees of a closed task. Worktrees that still
 * hold changes (git refuses those) and missing ones stay; their paths are
 * returned so the user can find them. Branches are kept: they may hold
 * commits and pull requests.
 */
export async function removeLinkedTaskCheckouts(repos: readonly LinkedTaskRepo[]): Promise<string[]> {
  const preserved: string[] = []
  for (const repo of repos) {
    if (!repo.managed) continue
    try {
      await removeGitWorktree(repo.repoRoot, repo.workPath)
    } catch (error) {
      preserved.push(repo.workPath)
      appLog.warn('linked-task', 'Preserved a linked task worktree while closing its tab', failureDetail(error, tEnglish))
    }
  }
  return preserved
}
