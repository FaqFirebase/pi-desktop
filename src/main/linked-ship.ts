import { existsSync } from 'fs'
import type {
  GitConveyorCommitOptions,
  GitConveyorPullRequestOptions,
  GitConveyorPullRequestResult,
  GitConveyorStatus,
  LinkedRepoShipResult,
  LinkedShipRequest,
  LinkedShipResult,
  LinkedShipStep,
  LinkedTaskRepo,
} from '../shared/ipc-contracts'
import { t } from '../shared/i18n'
import {
  CONVENTIONAL_BASE_BRANCHES,
  commitAll,
  createPullRequest,
  getGitConveyorStatus,
  listChangedPaths,
  pushBranch,
  readPullRequestBody,
  updatePullRequestBody,
  type ChangedPaths,
} from './git-conveyor'

/** Marks the app-written section of a pull request description, so a later ship replaces it. */
export const LINKED_PULL_REQUESTS_START = '<!-- pi-desktop:linked-pull-requests -->'
export const LINKED_PULL_REQUESTS_END = '<!-- /pi-desktop:linked-pull-requests -->'
/** Section heading in the pull request; GitHub content, so not translated. */
const LINKED_PULL_REQUESTS_HEADING = '### Linked pull requests'

/** The git and GitHub operations a ship runs; injected by tests. */
export interface LinkedShipOperations {
  exists(path: string): boolean
  status(cwd: string): Promise<GitConveyorStatus>
  changedPaths(cwd: string): Promise<ChangedPaths>
  commit(cwd: string, options: GitConveyorCommitOptions): Promise<GitConveyorStatus>
  push(cwd: string): Promise<GitConveyorStatus>
  createPullRequest(cwd: string, options: GitConveyorPullRequestOptions): Promise<GitConveyorPullRequestResult>
  readPullRequestBody(cwd: string, url: string): Promise<string>
  updatePullRequestBody(cwd: string, url: string, body: string): Promise<void>
}

export const GIT_LINKED_SHIP_OPERATIONS: LinkedShipOperations = {
  exists: existsSync,
  status: getGitConveyorStatus,
  changedPaths: listChangedPaths,
  commit: commitAll,
  push: pushBranch,
  createPullRequest,
  readPullRequestBody,
  updatePullRequestBody,
}

interface PullRequestLink {
  name: string
  url: string
}

/** Linked repositories in set order, then the main one: the main change lands last. */
export function shipOrder(repos: readonly LinkedTaskRepo[]): LinkedTaskRepo[] {
  return [...repos.filter((repo) => repo.role === 'linked'), ...repos.filter((repo) => repo.role === 'main')]
}

/**
 * `body` with its linked pull requests section listing `links`, replacing a
 * section an earlier ship wrote. No links removes the section.
 */
export function withLinkedPullRequests(body: string, links: readonly PullRequestLink[]): string {
  const start = body.indexOf(LINKED_PULL_REQUESTS_START)
  const end = body.indexOf(LINKED_PULL_REQUESTS_END)
  const own = start !== -1 && end > start
    ? `${body.slice(0, start)}${body.slice(end + LINKED_PULL_REQUESTS_END.length)}`.trim()
    : body.trim()
  if (links.length === 0) return own
  const section = [
    LINKED_PULL_REQUESTS_START,
    LINKED_PULL_REQUESTS_HEADING,
    ...links.map((link) => `- ${link.name}: ${link.url}`),
    LINKED_PULL_REQUESTS_END,
  ].join('\n')
  return own ? `${own}\n\n${section}` : section
}

/**
 * The checked-out branch is the base branch. With no remote default branch
 * known, the conventional default names count as base, so an in-place task
 * on `main` is never committed to directly.
 */
function onBaseBranch(status: GitConveyorStatus): boolean {
  if (!status.branch) return false
  return status.baseBranch !== null
    ? status.branch === status.baseBranch
    : (CONVENTIONAL_BASE_BRANCHES as readonly string[]).includes(status.branch)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The branch has commits to publish. With a known base branch: commits the
 * base lacks. With an unknown base (no remote default branch): a commit made
 * by this ship, a worktree HEAD that moved off its start commit, or commits
 * an existing upstream lacks. A fresh worktree nobody changed has none.
 */
function hasCommitsToShip(status: GitConveyorStatus, repo: LinkedTaskRepo, committedNow: boolean): boolean {
  if (status.aheadOfBase !== null) return status.aheadOfBase > 0
  if (committedNow) return true
  if (repo.baseRef) return status.head !== repo.baseRef
  return status.hasUpstream && status.ahead > 0
}

/**
 * Commit, push, and open a pull request in one repository, each only when
 * needed, so running it again after a failure resumes at the failed step.
 */
async function shipRepository(
  repo: LinkedTaskRepo, request: LinkedShipRequest, operations: LinkedShipOperations,
): Promise<LinkedRepoShipResult> {
  if (!operations.exists(repo.workPath)) return { name: repo.name, outcome: 'missing', pullRequestUrl: null }
  const cwd = repo.workPath
  const checkedNewFiles = request.newFiles[repo.name] ?? []
  let step: LinkedShipStep = 'commit'
  let shipped = false
  try {
    let status = await operations.status(cwd)
    // A retry sends the same checked files again; the ones an earlier ship
    // committed are no longer new and must not make an empty commit.
    const changed = checkedNewFiles.length > 0 ? await operations.changedPaths(cwd) : null
    const chosenNewFiles = changed ? checkedNewFiles.filter((path) => changed.untracked.includes(path)) : []
    const hasChanges = status.dirtyTrackedFiles > 0 || chosenNewFiles.length > 0
    // A linked change ships as pull requests; it never lands on the base branch directly.
    if (onBaseBranch(status) && (hasChanges || hasCommitsToShip(status, repo, false))) {
      throw new Error(t('repoSets.ship.errors.onBaseBranch', { branch: status.branch }))
    }
    if (hasChanges) {
      const options: GitConveyorCommitOptions = { message: request.message }
      if (changed && chosenNewFiles.length > 0) {
        options.paths = [...changed.tracked, ...chosenNewFiles]
        options.newFiles = chosenNewFiles
      }
      status = await operations.commit(cwd, options)
      shipped = true
    }
    step = 'push'
    if (hasCommitsToShip(status, repo, shipped) && (status.ahead > 0 || !status.hasUpstream)) {
      status = await operations.push(cwd)
      shipped = true
    }
    step = 'pullRequest'
    if (status.openPullRequest || !status.branch || !hasCommitsToShip(status, repo, shipped)) {
      return { name: repo.name, outcome: shipped ? 'shipped' : 'unchanged', pullRequestUrl: status.openPullRequest?.url ?? null }
    }
    if (!status.pullRequestRepo) throw new Error(t('conveyor.errors.prNeedsGitHub'))
    const created = await operations.createPullRequest(cwd, { title: request.title, body: request.body })
    return { name: repo.name, outcome: 'shipped', pullRequestUrl: created.url }
  } catch (error) {
    return { name: repo.name, outcome: 'failed', failedStep: step, error: errorText(error), pullRequestUrl: null }
  }
}

/** The open pull request of every repository: from this ship, else from GitHub. */
async function collectPullRequests(
  repos: readonly LinkedTaskRepo[], results: readonly LinkedRepoShipResult[], operations: LinkedShipOperations,
): Promise<PullRequestLink[]> {
  const links: PullRequestLink[] = []
  for (const repo of repos) {
    const shipped = results.find((result) => result.name === repo.name)
    if (shipped?.pullRequestUrl) {
      links.push({ name: repo.name, url: shipped.pullRequestUrl })
      continue
    }
    if (shipped || !operations.exists(repo.workPath)) continue
    const url = await operations.status(repo.workPath).then((status) => status.openPullRequest?.url ?? null, () => null)
    if (url) links.push({ name: repo.name, url })
  }
  return links
}

/**
 * Ship a linked task: every requested repository in `shipOrder`, one at a
 * time. A failure stops only its own repository. Afterwards, while at least
 * two pull requests exist, each one's description lists the others.
 */
export async function shipLinkedTask(
  repos: readonly LinkedTaskRepo[],
  request: LinkedShipRequest,
  operations: LinkedShipOperations = GIT_LINKED_SHIP_OPERATIONS,
): Promise<LinkedShipResult> {
  const ordered = shipOrder(repos)
  const targets = request.repos ? ordered.filter((repo) => request.repos!.includes(repo.name)) : ordered
  const results: LinkedRepoShipResult[] = []
  for (const repo of targets) results.push(await shipRepository(repo, request, operations))

  const links = await collectPullRequests(ordered, results, operations)
  if (links.length < 2) return { repos: results }
  for (const link of links) {
    const repo = ordered.find((item) => item.name === link.name)!
    try {
      const body = await operations.readPullRequestBody(repo.workPath, link.url)
      const others = links.filter((other) => other.url !== link.url)
      await operations.updatePullRequestBody(repo.workPath, link.url, withLinkedPullRequests(body, others))
    } catch (error) {
      const failed: LinkedRepoShipResult = {
        name: link.name, outcome: 'failed', failedStep: 'link', error: errorText(error), pullRequestUrl: link.url,
      }
      const index = results.findIndex((result) => result.name === link.name)
      if (index === -1) results.push(failed)
      else results[index] = failed
    }
  }
  return { repos: results }
}
