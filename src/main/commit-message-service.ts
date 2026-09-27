import { realpath } from 'fs/promises'
import type { GitCommitMessageError, GitCommitMessageSuggestion } from '../shared/ipc-contracts'
import { readCommitDiff, type CommitDiffSnapshot } from './git-conveyor'

/** `reason` is a fixed diagnostic phrase, never provider output. */
export class CommitMessageGenerationError extends Error {
  constructor(readonly code: GitCommitMessageError, readonly reason: string) {
    super(`Commit message generation failed: ${code}`)
  }
}

export type CommitMessageGenerator = (diff: string, signal: AbortSignal) => Promise<string>

interface SuggestionEntry {
  fingerprint: string
  result: Promise<string>
  controller: AbortController
  settled: boolean
}

interface CommitMessageDeps {
  resolvePath(cwd: string): Promise<string>
  readDiff(cwd: string, paths?: readonly string[]): Promise<CommitDiffSnapshot | null>
}

/**
 * One suggestion per physical workspace scope (linked worktrees stay separate),
 * keyed by the commit diff. A diff already suggested or in flight is reused;
 * failures are not kept, so the next request tries again.
 */
export class CommitMessageService {
  private readonly entries = new Map<string, SuggestionEntry>()
  private disposed = false

  constructor(private readonly deps: CommitMessageDeps = { resolvePath: realpath, readDiff: readCommitDiff }) {}

  /** `force` replaces a finished suggestion for the same diff; it never duplicates an in-flight one. */
  async suggest(
    cwd: string, generate: CommitMessageGenerator, force = false, paths?: readonly string[],
  ): Promise<GitCommitMessageSuggestion> {
    const key = await this.deps.resolvePath(cwd)
    const snapshot = await this.deps.readDiff(key, paths)
    if (!snapshot || this.disposed) return { message: null, error: null }
    let entry = this.entries.get(key)
    if (!entry || entry.fingerprint !== snapshot.fingerprint || (force && entry.settled)) {
      entry?.controller.abort()
      entry = this.start(key, snapshot, generate)
    }
    try {
      return { message: await entry.result, error: null }
    } catch (error) {
      // Do not forward provider output: it can contain prompt text or credentials.
      return { message: null, error: error instanceof CommitMessageGenerationError ? error.code : 'generation-failed' }
    }
  }

  private start(key: string, snapshot: CommitDiffSnapshot, generate: CommitMessageGenerator): SuggestionEntry {
    const controller = new AbortController()
    const entry: SuggestionEntry = {
      fingerprint: snapshot.fingerprint,
      result: generate(snapshot.diff, controller.signal),
      controller,
      settled: false,
    }
    this.entries.set(key, entry)
    entry.result.then(() => { entry.settled = true }, () => {
      entry.settled = true
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    return entry
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) entry.controller.abort()
    this.entries.clear()
  }
}
