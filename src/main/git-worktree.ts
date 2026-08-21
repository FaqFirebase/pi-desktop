import { spawn } from 'child_process'
import { mkdir } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'

export interface GitCommandResult {
  stdout: string
  stderr: string
}

export interface GitRepositoryInfo {
  /** The main repository root, shared by linked worktrees. */
  repoRoot: string
  /** The commit checked out by the inspected worktree. */
  head: string
  branch: string | null
  /** Porcelain status; empty means the worktree is clean. */
  status: string
}

export interface GitWorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
}

export function runGit(args: readonly string[], cwd: string): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }
      const detail = (stderr || stdout).trim()
      reject(new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`))
    })
  })
}

async function gitValue(args: readonly string[], cwd: string): Promise<string> {
  return (await runGit(args, cwd)).stdout.trim()
}

/** Parse `git worktree list --porcelain` without losing Windows paths. */
export function parseGitWorktrees(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = []
  let current: GitWorktreeEntry | null = null

  const flush = (): void => {
    if (current) entries.push(current)
    current = null
  }

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    const separator = line.indexOf(' ')
    const key = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1)
    if (key === 'worktree') {
      flush()
      current = { path: value, head: null, branch: null, bare: false }
    } else if (!current) {
      continue
    } else if (key === 'HEAD') {
      current.head = value || null
    } else if (key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '') || null
    } else if (key === 'bare') {
      current.bare = true
    }
  }
  flush()
  return entries
}

export async function listGitWorktrees(cwd: string): Promise<GitWorktreeEntry[]> {
  return parseGitWorktrees(await gitValue(['worktree', 'list', '--porcelain'], cwd))
}

/**
 * Return the main repository root and the current worktree state. Calling this
 * from a linked worktree is intentional: HEAD and dirty files must come from
 * the worktree the user is cloning, not from the main checkout.
 */
export async function inspectGitRepository(cwd: string): Promise<GitRepositoryInfo> {
  const worktreeRoot = await gitValue(['rev-parse', '--show-toplevel'], cwd)
  const commonDirRaw = await gitValue(['rev-parse', '--git-common-dir'], cwd)
  const commonDir = resolve(cwd, commonDirRaw)
  const repoRoot = dirname(commonDir)
  const [head, branch, status] = await Promise.all([
    // An unborn branch has no HEAD yet, but its worktree is still valid and
    // must be able to reach the first commit through the conveyor.
    gitValue(['rev-parse', '--verify', 'HEAD'], cwd).catch(() => ''),
    gitValue(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).catch(() => null),
    gitValue(['status', '--porcelain=v1', '--untracked-files=all'], cwd),
  ])

  // `--show-toplevel` also validates that the path is a usable checkout. Keep
  // the variable read above so a future Git implementation cannot accidentally
  // accept a bare repository without noticing the worktree requirement.
  if (!worktreeRoot) throw new Error('Git returned an empty worktree root')
  return { repoRoot, head, branch, status }
}

export function slugifyWorktreePart(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'tab'
}

export function worktreeTargetPath(
  guiWorktreesDir: string,
  repoRoot: string,
  workspaceId: string,
): string {
  const repoName = slugifyWorktreePart(basename(repoRoot))
  return join(guiWorktreesDir, repoName, `${repoName}-${workspaceId}`)
}

export function worktreeBranchName(label: string, workspaceId: string): string {
  return `pi/${slugifyWorktreePart(label)}-${workspaceId.replace(/^ws-/, '')}`
}

export async function createGitWorktree(options: {
  sourceCwd: string
  targetPath: string
  branch: string
}): Promise<void> {
  await mkdir(dirname(options.targetPath), { recursive: true })
  await runGit(['worktree', 'add', '-b', options.branch, options.targetPath, 'HEAD'], options.sourceCwd)
}

/** Remove only a clean worktree. Git refuses dirty worktrees, preserving edits. */
export async function removeGitWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await runGit(['worktree', 'remove', worktreePath], repoRoot)
}
