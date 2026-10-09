import type { LinkedRepoStatus, LinkedTaskRepo } from '../shared/ipc-contracts'
import { GIT_LINKED_SHIP_OPERATIONS, type LinkedShipOperations } from './linked-ship'

type StatusOperations = Pick<LinkedShipOperations, 'exists' | 'status' | 'changedPaths'>

/**
 * One repo bar row per repository. A checkout that is gone, or that git cannot
 * read, shows as empty rather than failing the whole bar.
 */
export async function readLinkedRepoStatuses(
  repos: readonly LinkedTaskRepo[],
  focusedName: string,
  operations: StatusOperations = GIT_LINKED_SHIP_OPERATIONS,
): Promise<LinkedRepoStatus[]> {
  return Promise.all(repos.map(async (repo): Promise<LinkedRepoStatus> => {
    const row: LinkedRepoStatus = {
      name: repo.name,
      role: repo.role,
      workPath: repo.workPath,
      branch: repo.branch,
      exists: operations.exists(repo.workPath),
      focused: repo.name === focusedName,
      changedFiles: 0,
      newFiles: [],
      pullRequestUrl: null,
      sourceWasDirty: repo.sourceWasDirty === true,
    }
    if (!row.exists) return row
    try {
      const [status, changed] = await Promise.all([operations.status(repo.workPath), operations.changedPaths(repo.workPath)])
      return {
        ...row,
        branch: status.branch,
        changedFiles: status.dirtyFiles,
        newFiles: changed.untracked,
        pullRequestUrl: status.openPullRequest?.url ?? null,
      }
    } catch {
      return row
    }
  }))
}
