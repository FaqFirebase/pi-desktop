import type { LinkedShipResult } from '../../../shared/ipc-contracts'

/** Repositories to ship again: the ones whose last result failed. */
export function failedRepoNames(result: LinkedShipResult): string[] {
  return result.repos.filter((repo) => repo.outcome === 'failed').map((repo) => repo.name)
}

/**
 * Fold a retry into the earlier result: a repository the retry reports
 * replaces its earlier row, in place; a repository it reports for the first
 * time (a linking failure elsewhere) is added at the end.
 */
export function mergeShipResults(previous: LinkedShipResult, retry: LinkedShipResult): LinkedShipResult {
  const updated = new Map(retry.repos.map((repo) => [repo.name, repo]))
  const merged = previous.repos.map((repo) => updated.get(repo.name) ?? repo)
  const known = new Set(previous.repos.map((repo) => repo.name))
  return { repos: [...merged, ...retry.repos.filter((repo) => !known.has(repo.name))] }
}
