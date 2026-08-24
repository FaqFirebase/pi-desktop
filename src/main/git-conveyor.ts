import { access, realpath } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { inspectGitRepository, isMissingRepositoryError, runGit } from './git-worktree'
import type {
  GitConveyorCommitOptions,
  GitConveyorPullRequestOptions,
  GitConveyorPullRequestResult,
  GitConveyorStatus,
} from '../shared/ipc-contracts'

const COMMAND_TIMEOUT_MS = 30_000

/** Status of a workspace folder that Git does not track. */
const NOT_A_REPOSITORY_STATUS: GitConveyorStatus = Object.freeze({
  branch: null,
  head: '',
  lastCommitMessage: null,
  dirtyFiles: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  pushRemote: null,
  upstreamBranch: null,
  baseBranch: null,
  remoteUrl: null,
})

const GIT_OPERATION_MARKERS = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['BISECT_LOG', 'bisect'],
] as const

interface UpstreamConfig {
  remote: string
  branch: string
}

export function countPorcelainFiles(status: string): number {
  return status.split(/\r?\n/).filter((line) => line.trim().length > 0).length
}

export function parseAheadBehind(value: string | null): { ahead: number; behind: number } {
  if (!value) return { ahead: 0, behind: 0 }
  const [behind, ahead] = value.trim().split(/\s+/).map(Number)
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  }
}

export function extractUrl(output: string): string | null {
  return output.match(/https?:\/\/[^\s]+/)?.[0] ?? null
}

export function extractGitHubPullRequestUrl(value: string): string | null {
  return value.match(/https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i)?.[0] ?? null
}

export async function resolvePullRequestHeadBranch(cwd: string, url: string): Promise<string | null> {
  const output = await runCommand('gh', ['pr', 'view', url, '--json', 'headRefName'], cwd)
  try {
    const value = JSON.parse(output) as { headRefName?: unknown }
    return typeof value.headRefName === 'string' && value.headRefName.trim()
      ? value.headRefName.trim()
      : null
  } catch {
    return null
  }
}

export function githubRepoFromRemote(remote: string | null): string | null {
  if (!remote) return null
  const match = remote.trim().replace(/\.git$/, '').match(/github\.com[:/]([^/]+\/[^/]+)$/i)
  return match?.[1] ?? null
}

function runCommand(file: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${file} ${args.join(' ')} timed out`))
    }, COMMAND_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const output = (stdout || stderr).trim()
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${file} ${args.join(' ')} failed${output ? `: ${output}` : ''}`))
    })
  })
}

async function gitConfig(cwd: string, key: string): Promise<string | null> {
  return runGit(['config', '--get', key], cwd)
    .then((result) => result.stdout.trim() || null)
    .catch(() => null)
}

async function branchRemote(cwd: string, branch: string): Promise<string | null> {
  return gitConfig(cwd, `branch.${branch}.remote`)
}

async function resolveUpstream(cwd: string, branch: string): Promise<UpstreamConfig | null> {
  const [remote, merge] = await Promise.all([
    branchRemote(cwd, branch),
    gitConfig(cwd, `branch.${branch}.merge`),
  ])
  if (!remote || !merge?.startsWith('refs/heads/')) return null
  return { remote, branch: merge.slice('refs/heads/'.length) }
}

async function defaultBranchForRemote(cwd: string, remote: string | null): Promise<string | null> {
  if (!remote || remote === '.') return null
  const ref = await runGit(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], cwd)
    .then((result) => result.stdout.trim())
    .catch(() => '')
  const prefix = `${remote}/`
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null
}

async function activeGitOperation(cwd: string): Promise<string | null> {
  const markers = await Promise.all(
    GIT_OPERATION_MARKERS.map(async ([marker, label]) => {
      const gitPath = await runGit(['rev-parse', '--git-path', marker], cwd)
        .then((result) => result.stdout.trim())
        .catch(() => '')
      if (!gitPath) return null
      try {
        await access(resolve(cwd, gitPath))
        return label
      } catch {
        return null
      }
    })
  )
  return markers.find((label) => label !== null) ?? null
}

function isPathWithin(base: string, candidate: string): boolean {
  const relativePath = relative(resolve(base), resolve(base, candidate))
  return relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

/**
 * Absolute paths of every staged entry. `--relative` is deliberately not used:
 * it drops the paths outside `cwd`, which is exactly the set the workspace
 * guard has to see, so Git reports repository-root paths that are resolved
 * against the worktree root here instead. Git prints that root with symlinks
 * resolved, so the paths are physical and must be compared as such.
 */
async function stagedPaths(cwd: string): Promise<string[]> {
  const [worktreeRoot, output] = await Promise.all([
    runGit(['rev-parse', '--show-toplevel'], cwd).then((result) => realpath(result.stdout.trim())),
    runGit(['diff', '--cached', '--name-only', '-z'], cwd).then((result) => result.stdout),
  ])
  return output.split('\0').filter(Boolean).map((path) => resolve(worktreeRoot, path))
}

/**
 * True when tracked files below `cwd` differ from the index. `git add --update`
 * fails when its pathspec matches no tracked file at all, so auto-staging asks
 * this first and can report the untracked-only case in its own words.
 */
async function hasUnstagedTrackedChanges(cwd: string): Promise<boolean> {
  const result = await runGit(['diff', '--name-only', '-z', '--', '.'], cwd)
  return result.stdout.split('\0').some((path) => path.length > 0)
}

/** Record the index as a tree object so a failed commit can restore it. */
async function snapshotIndex(cwd: string): Promise<string> {
  const result = await runGit(['write-tree'], cwd)
  return result.stdout.trim()
}

export async function getGitConveyorStatus(cwd: string): Promise<GitConveyorStatus> {
  // A workspace does not have to be a repository. Every other probe below
  // already degrades to a null field, so report the same empty shape instead of
  // pushing raw Git output into a header the renderer polls every few seconds.
  // No branch and no dirty file keeps commit, push, and pull request disabled.
  const repository = await inspectGitRepository(cwd).catch((error: unknown) => {
    if (isMissingRepositoryError(error)) return null
    throw error
  })
  if (!repository) return NOT_A_REPOSITORY_STATUS
  const upstream = repository.branch ? await resolveUpstream(cwd, repository.branch) : null
  const configuredRemote = repository.branch ? await branchRemote(cwd, repository.branch) : null
  const pushRemote = upstream?.remote ?? configuredRemote ?? (await gitConfig(cwd, 'remote.origin.url') ? 'origin' : null)
  const baseRemote = (await gitConfig(cwd, 'remote.upstream.url')) ? 'upstream' : upstream?.remote ?? null
  const [lastCommitMessage, counts, remoteUrl, baseBranch] = await Promise.all([
    runGit(['log', '-1', '--pretty=%s'], cwd).then((result) => result.stdout.trim()).catch(() => ''),
    runGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd).then((result) => result.stdout.trim()).catch(() => null),
    runGit(['config', '--get', 'remote.origin.url'], cwd).then((result) => result.stdout.trim()).catch(() => ''),
    defaultBranchForRemote(cwd, baseRemote),
  ])
  return {
    branch: repository.branch,
    head: repository.head,
    lastCommitMessage: lastCommitMessage || null,
    dirtyFiles: countPorcelainFiles(repository.status),
    ...parseAheadBehind(counts),
    hasUpstream: !!upstream,
    pushRemote,
    upstreamBranch: upstream?.branch ?? null,
    baseBranch,
    remoteUrl: remoteUrl || null,
  }
}

export async function commitAll(cwd: string, options: GitConveyorCommitOptions): Promise<GitConveyorStatus> {
  const message = options.message.trim()
  if (!message) throw new Error('Commit message is required')
  if (message.length > 200) throw new Error('Commit message must be 200 characters or fewer')
  const repository = await inspectGitRepository(cwd)
  if (!repository.branch) throw new Error('Cannot commit from a detached HEAD')
  const operation = await activeGitOperation(cwd)
  if (operation) throw new Error(`Cannot commit while a Git ${operation} is in progress`)
  if (!repository.status.trim()) throw new Error('Working tree is clean')

  // Preserve an intentionally curated index. Only auto-stage when there is no
  // staged content at all, and never allow staged paths outside the workspace
  // to be swept into a commit opened from a monorepo subdirectory.
  const staged = await stagedPaths(cwd)
  // Both sides of the comparison must be physical paths: a workspace can be
  // opened through a symlink while Git always reports the resolved worktree.
  const workspaceRoot = await realpath(cwd)
  const outsideWorkspace = staged.filter((path) => !isPathWithin(workspaceRoot, path))
  if (outsideWorkspace.length > 0) {
    throw new Error('The index contains staged files outside the active workspace')
  }

  // Auto-staging covers tracked modifications only. A stray secret, key, or
  // build artefact sitting untracked in the workspace reaches a commit only
  // after the user staged it deliberately. The Commit button counts untracked
  // rows too, so say plainly when that leaves nothing to commit.
  const autoStage = staged.length === 0
  if (autoStage && !(await hasUnstagedTrackedChanges(cwd))) {
    throw new Error('No tracked changes to commit in this workspace. Stage untracked files first to include them.')
  }
  // The snapshot records the index as a tree, so a rejected commit restores
  // exactly what was staged before. `git reset` would instead unstage the whole
  // index: equivalent only while auto-staging is gated on an empty index, while
  // the snapshot stays correct whatever that gate becomes.
  const indexSnapshot = autoStage ? await snapshotIndex(cwd) : null
  try {
    if (autoStage) await runGit(['add', '--update', '--', '.'], cwd)
    await runGit(['commit', '-m', message], cwd)
  } catch (error) {
    if (indexSnapshot) await runGit(['read-tree', indexSnapshot], cwd)
    throw error
  }
  return getGitConveyorStatus(cwd)
}

export async function pushBranch(cwd: string): Promise<GitConveyorStatus> {
  const repository = await inspectGitRepository(cwd)
  if (!repository.branch) throw new Error('Cannot push from a detached HEAD')
  if (repository.status.trim()) throw new Error('Commit the working tree before pushing')
  const operation = await activeGitOperation(cwd)
  if (operation) throw new Error(`Cannot push while a Git ${operation} is in progress`)
  const upstream = await resolveUpstream(cwd, repository.branch)
  const configuredRemote = await branchRemote(cwd, repository.branch)
  const remote = upstream?.remote ?? configuredRemote ?? 'origin'
  if (remote === '.') throw new Error('Cannot push a branch whose upstream is the local repository')
  const branch = upstream?.branch ?? repository.branch
  const args = ['push']
  if (!upstream) args.push('--set-upstream')
  args.push(remote, `HEAD:${branch}`)
  await runGit(args, cwd)
  return getGitConveyorStatus(cwd)
}

export async function createPullRequest(
  cwd: string,
  options: GitConveyorPullRequestOptions,
): Promise<GitConveyorPullRequestResult> {
  const title = options.title.trim()
  if (!title) throw new Error('Pull request title is required')
  const body = options.body.trim()
  const status = await getGitConveyorStatus(cwd)
  if (status.dirtyFiles > 0) throw new Error('Commit the working tree before creating a pull request')
  if (!status.hasUpstream) throw new Error('Push the branch before creating a pull request')
  if (status.ahead > 0) throw new Error('Push the branch before creating a pull request')
  const branch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
    .then((result) => result.stdout.trim())
    .catch(() => '')
  if (!branch) throw new Error('A named branch is required to create a pull request')
  const [upstream, branchRemoteName, upstreamRemote, originRemote] = await Promise.all([
    resolveUpstream(cwd, branch),
    branchRemote(cwd, branch),
    gitConfig(cwd, 'remote.upstream.url'),
    gitConfig(cwd, 'remote.origin.url'),
  ])
  const baseRemoteName = upstreamRemote ? 'upstream' : upstream?.remote ?? null
  const headRemoteName = branchRemoteName ?? upstream?.remote ?? 'origin'
  const [baseBranch, baseRemoteUrl, headRemoteUrl] = await Promise.all([
    options.base?.trim() || defaultBranchForRemote(cwd, baseRemoteName),
    baseRemoteName ? gitConfig(cwd, `remote.${baseRemoteName}.url`) : Promise.resolve(null),
    gitConfig(cwd, `remote.${headRemoteName}.url`),
  ])
  const baseRepo = githubRepoFromRemote(baseRemoteUrl ?? upstreamRemote)
  const headRepo = githubRepoFromRemote(headRemoteUrl ?? originRemote)
  const headBranch = upstream?.branch ?? branch
  const args = ['pr', 'create']
  if (baseRepo) args.push('--repo', baseRepo)
  if (baseBranch) args.push('--base', baseBranch)
  args.push('--head', headRepo ? `${headRepo.split('/')[0]}:${headBranch}` : headBranch)
  args.push('--title', title, '--body', body)
  if (options.draft) args.push('--draft')
  const output = await runCommand('gh', args, cwd)
  return { url: extractUrl(output), output }
}
