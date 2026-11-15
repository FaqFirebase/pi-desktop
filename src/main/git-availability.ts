import { homedir } from 'os'
import type { GitAvailability } from '../shared/ipc-contracts'
import { GitCommandError, GitNotInstalledError, runGit, type GitCommandResult } from './git-worktree'

export const GIT_VERSION_ARGS: readonly string[] = ['--version']

/** `git version 2.47.1`, `git version 2.43.0.windows.1`, `git version 2.39.5 (Apple Git-154)`. */
const GIT_VERSION_PATTERN = /^git version (\S+)/

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

/** The version token of `git --version` output, or null when the text is not a version line. */
export function parseGitVersion(output: string): string | null {
  return GIT_VERSION_PATTERN.exec(firstNonEmptyLine(output))?.[1] ?? null
}

/**
 * Run `git --version` by bare name, the way every git action runs git. The
 * home folder is the working folder because it always exists; a workspace
 * folder may be gone.
 */
export async function probeGitAvailability(
  runVersion: () => Promise<GitCommandResult> = () => runGit(GIT_VERSION_ARGS, homedir()),
): Promise<GitAvailability> {
  let output: string
  try {
    output = (await runVersion()).stdout
  } catch (error) {
    if (error instanceof GitNotInstalledError) return { status: 'missing' }
    if (error instanceof GitCommandError) {
      return { status: 'failed', detail: firstNonEmptyLine(error.stderr || error.stdout) || error.message }
    }
    return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
  const version = parseGitVersion(output)
  return version ? { status: 'found', version } : { status: 'failed', detail: firstNonEmptyLine(output) }
}

export interface GitAvailabilityCache {
  get(): Promise<GitAvailability>
  recheck(): Promise<GitAvailability>
}

/**
 * `get` starts the probe once and shares that promise; `recheck` starts a new
 * probe and caches it, so a later `get` returns the newest result.
 */
export function createGitAvailabilityCache(probe: () => Promise<GitAvailability>): GitAvailabilityCache {
  let cached: Promise<GitAvailability> | null = null
  const recheck = (): Promise<GitAvailability> => {
    cached = probe()
    return cached
  }
  return {
    get: () => cached ?? recheck(),
    recheck,
  }
}
