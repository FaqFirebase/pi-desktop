import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, GitCommitHorizontal, GitPullRequest, Loader2, Upload } from 'lucide-react'
import { clsx } from 'clsx'
import type { GitConveyorStatus } from '../../../shared/ipc-contracts'
import { formatIpcError } from '../utils/ipc-error'

export function GitConveyorActions({ onChanged }: { onChanged?: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<GitConveyorStatus | null>(null)
  const [busy, setBusy] = useState<'commit' | 'push' | 'pr' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.piDesktop.git.status())
      setError(null)
    } catch (err) {
      setStatus(null)
      setError(formatIpcError(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const run = async <T,>(kind: 'commit' | 'push' | 'pr', action: () => Promise<T>, success: (result: T) => string): Promise<void> => {
    if (busy) return
    setBusy(kind)
    setError(null)
    setFeedback(null)
    try {
      const result = await action()
      setFeedback(success(result))
      await refresh()
      onChanged?.()
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      setBusy(null)
    }
  }

  const commit = (): void => {
    const message = window.prompt('Commit message', status?.lastCommitMessage ?? 'chore: update implementation')
    if (message === null || !message.trim()) return
    void run('commit', () => window.piDesktop.git.commit({ message }), (next) => `Committed ${next.head.slice(0, 8)}.`)
  }

  const push = (): void => {
    if (status?.dirtyFiles) {
      setError('Commit the working tree before pushing.')
      return
    }
    void run('push', () => window.piDesktop.git.push(), (next) => next.ahead > 0 ? `Pushed ${next.ahead} commit${next.ahead === 1 ? '' : 's'}.` : 'Branch pushed.')
  }

  const createPr = (): void => {
    if (!status?.branch) {
      setError('A named branch is required to create a pull request.')
      return
    }
    if (status.dirtyFiles || status.ahead > 0) {
      setError(status.dirtyFiles ? 'Commit changes before creating a pull request.' : 'Push the branch before creating a pull request.')
      return
    }
    const title = window.prompt('Pull request title', status.lastCommitMessage ?? status.branch)
    if (title === null || !title.trim()) return
    const body = window.prompt('Pull request description', '## Summary\n\n## Verification\n')
    if (body === null) return
    void run('pr', async () => {
      const result = await window.piDesktop.git.createPullRequest({ title, body })
      if (result.url) void window.piDesktop.system.openExternal(result.url)
      return result
    }, (result) => result.url ? `Pull request created: ${result.url}` : 'Pull request created.')
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      {status && (
        <span className="mr-1 max-w-44 truncate text-[10px] text-faint" title={status.branch ?? undefined}>
          {status.branch ?? 'detached'}{status.dirtyFiles > 0 ? ` · ${status.dirtyFiles} changed` : ''}
        </span>
      )}
      <button type="button" onClick={commit} disabled={busy !== null || !status?.dirtyFiles} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title="Stage all changes and commit">
        {busy === 'commit' ? <Loader2 size={11} className="animate-spin" /> : <GitCommitHorizontal size={11} />}
        Commit
      </button>
      <button type="button" onClick={push} disabled={busy !== null || !status || !!status.dirtyFiles || !status.branch} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title="Push the current branch">
        {busy === 'push' ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
        Push
      </button>
      <button type="button" onClick={createPr} disabled={busy !== null || !status || !!status.dirtyFiles || !!status.ahead || !status.branch} className={clsx('flex items-center gap-1 rounded border border-accent/50 px-2 py-1 text-[10px] text-accent-fg transition-colors hover:bg-accent-bg/20 disabled:cursor-not-allowed disabled:opacity-40')} title="Create a pull request with GitHub CLI">
        {busy === 'pr' ? <Loader2 size={11} className="animate-spin" /> : <GitPullRequest size={11} />}
        PR
      </button>
      {status?.remoteUrl && <ExternalLink size={11} className="text-faint" aria-hidden="true" />}
      {(error || feedback) && <span className={clsx('basis-full truncate text-[10px]', error ? 'text-error' : 'text-success')} role="status" title={error ?? feedback ?? undefined}>{error ?? feedback}</span>}
    </div>
  )
}
