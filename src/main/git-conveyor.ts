import { spawn } from 'child_process'
import { inspectGitRepository, runGit } from './git-worktree'
import type {
  GitConveyorCommitOptions,
  GitConveyorPullRequestOptions,
  GitConveyorPullRequestResult,
  GitConveyorStatus,
} from '../shared/ipc-contracts'

const COMMAND_TIMEOUT_MS = 30_000

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

export function githubRepoFromRemote(remote: string | null): string | null {
  if (!remote) return null
  const match = remote.trim().replace(/\.git$/, '').match(/github\.com[:/]([^/]+\/[^/]+)$/i)
  return match?.[1] ?? null
}

function runCommand(file: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
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
      if (code === 0) resolve(output)
      else reject(new Error(`${file} ${args.join(' ')} failed${output ? `: ${output}` : ''}`))
    })
  })
}

export async function getGitConveyorStatus(cwd: string): Promise<GitConveyorStatus> {
  const repository = await inspectGitRepository(cwd)
  const [lastCommitMessage, upstream, counts, remoteUrl] = await Promise.all([
    runGit(['log', '-1', '--pretty=%s'], cwd).then((result) => result.stdout.trim()).catch(() => ''),
    runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd).then((result) => result.stdout.trim()).catch(() => ''),
    runGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd).then((result) => result.stdout.trim()).catch(() => null),
    runGit(['config', '--get', 'remote.origin.url'], cwd).then((result) => result.stdout.trim()).catch(() => ''),
  ])
  return {
    branch: repository.branch,
    head: repository.head,
    lastCommitMessage: lastCommitMessage || null,
    dirtyFiles: countPorcelainFiles(repository.status),
    ...parseAheadBehind(counts),
    hasUpstream: !!upstream,
    remoteUrl: remoteUrl || null,
  }
}

export async function commitAll(cwd: string, options: GitConveyorCommitOptions): Promise<GitConveyorStatus> {
  const message = options.message.trim()
  if (!message) throw new Error('Commit message is required')
  if (message.length > 200) throw new Error('Commit message must be 200 characters or fewer')
  const repository = await inspectGitRepository(cwd)
  if (!repository.branch) throw new Error('Cannot commit from a detached HEAD')
  if (!repository.status.trim()) throw new Error('Working tree is clean')
  await runGit(['add', '-A'], cwd)
  await runGit(['commit', '-m', message], cwd)
  return getGitConveyorStatus(cwd)
}

export async function pushBranch(cwd: string): Promise<GitConveyorStatus> {
  const repository = await inspectGitRepository(cwd)
  if (!repository.branch) throw new Error('Cannot push from a detached HEAD')
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd)
    .then((result) => result.stdout.trim())
    .catch(() => '')
  await runGit(upstream ? ['push'] : ['push', '--set-upstream', 'origin', repository.branch], cwd)
  return getGitConveyorStatus(cwd)
}

export async function createPullRequest(
  cwd: string,
  options: GitConveyorPullRequestOptions,
): Promise<GitConveyorPullRequestResult> {
  const title = options.title.trim()
  if (!title) throw new Error('Pull request title is required')
  const body = options.body.trim()
  const [upstreamRemote, originRemote, branch] = await Promise.all([
    runGit(['config', '--get', 'remote.upstream.url'], cwd).then((result) => result.stdout.trim()).catch(() => ''),
    runGit(['config', '--get', 'remote.origin.url'], cwd).then((result) => result.stdout.trim()).catch(() => ''),
    runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).then((result) => result.stdout.trim()).catch(() => ''),
  ])
  const baseRepo = githubRepoFromRemote(upstreamRemote)
  const originRepo = githubRepoFromRemote(originRemote)
  const args = ['pr', 'create']
  if (baseRepo) args.push('--repo', baseRepo)
  if (branch) args.push('--head', originRepo ? `${originRepo.split('/')[0]}:${branch}` : branch)
  args.push('--title', title, '--body', body)
  if (options.draft) args.push('--draft')
  const output = await runCommand('gh', args, cwd)
  return { url: extractUrl(output), output }
}
