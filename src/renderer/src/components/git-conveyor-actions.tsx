import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, GitCommitHorizontal, GitPullRequest, Loader2, Upload, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import type { GitConveyorStatus } from '../../../shared/ipc-contracts'
import { formatIpcError } from '../utils/ipc-error'

type ConveyorDialog =
  | { kind: 'commit'; message: string }
  | { kind: 'pr'; title: string; body: string; base: string }

export function GitConveyorActions({ onChanged }: { onChanged?: () => void }): React.JSX.Element {
  const requestConfirm = useAppStore((state) => state.requestConfirm)
  const [status, setStatus] = useState<GitConveyorStatus | null>(null)
  const [busy, setBusy] = useState<'commit' | 'push' | 'pr' | null>(null)
  const [dialog, setDialog] = useState<ConveyorDialog | null>(null)
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
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const run = async <T,>(
    kind: 'commit' | 'push' | 'pr',
    action: () => Promise<T>,
    success: (result: T) => string,
  ): Promise<void> => {
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

  const openCommitDialog = (): void => {
    setError(null)
    setDialog({
      kind: 'commit',
      message: status?.lastCommitMessage ?? 'chore: update implementation',
    })
  }

  const openPrDialog = (): void => {
    if (!status?.branch) {
      setError('A named branch is required to create a pull request.')
      return
    }
    if (status.dirtyFiles || status.ahead > 0 || !status.hasUpstream) {
      setError(
        status.dirtyFiles
          ? 'Commit changes before creating a pull request.'
          : 'Push the branch before creating a pull request.'
      )
      return
    }
    setDialog({
      kind: 'pr',
      title: status.lastCommitMessage ?? status.branch,
      body: '## Summary\n\n## Verification\n',
      base: status.baseBranch ?? '',
    })
  }

  const submitDialog = (): void => {
    if (!dialog) return
    if (dialog.kind === 'commit') {
      const message = dialog.message.trim()
      if (!message) {
        setError('Commit message is required.')
        return
      }
      setDialog(null)
      void run(
        'commit',
        () => window.piDesktop.git.commit({ message }),
        (next) => `Committed ${next.head.slice(0, 8)}.`,
      )
      return
    }

    const title = dialog.title.trim()
    const body = dialog.body.trim()
    if (!title) {
      setError('Pull request title is required.')
      return
    }
    setDialog(null)
    void run(
      'pr',
      async () => {
        const result = await window.piDesktop.git.createPullRequest({
          title,
          body,
          ...(dialog.base.trim() ? { base: dialog.base.trim() } : {}),
        })
        if (result.url) void window.piDesktop.system.openExternal(result.url)
        return result
      },
      (result) => result.url ? `Pull request created: ${result.url}` : 'Pull request created.',
    )
  }

  const push = async (): Promise<void> => {
    if (!status) return
    if (status.dirtyFiles) {
      setError('Commit the working tree before pushing.')
      return
    }
    const target = status.upstreamBranch
      ? `${status.pushRemote ?? 'remote'}/${status.upstreamBranch}`
      : `${status.pushRemote ?? 'origin'}/${status.branch ?? 'current branch'}`
    const confirmed = await requestConfirm({
      title: 'Push branch?',
      message: `Push ${status.branch ?? 'the current branch'} to ${target}?`,
      confirmLabel: 'Push',
      cancelLabel: 'Cancel',
      danger: true,
    })
    if (!confirmed) return
    void run(
      'push',
      () => window.piDesktop.git.push(),
      (next) => next.ahead > 0 ? `Pushed ${next.ahead} commit${next.ahead === 1 ? '' : 's'}.` : 'Branch pushed.',
    )
  }

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-start gap-1.5 lg:justify-end">
        {status && (
          <span className="basis-full mr-1 max-w-60 truncate text-[10px] text-faint sm:basis-auto" title={status.branch ?? undefined}>
            {status.branch ?? 'detached'}{status.dirtyFiles > 0 ? ` · ${status.dirtyFiles} changed` : ''}
          </span>
        )}
        <button type="button" onClick={openCommitDialog} disabled={busy !== null || !status?.dirtyFiles} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title="Commit staged changes or changes in this workspace">
          {busy === 'commit' ? <Loader2 size={11} className="animate-spin" /> : <GitCommitHorizontal size={11} />}
          Commit
        </button>
        <button type="button" onClick={() => void push()} disabled={busy !== null || !status || !!status.dirtyFiles || !status.branch} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title="Push the current branch after confirmation">
          {busy === 'push' ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          Push
        </button>
        <button type="button" onClick={openPrDialog} disabled={busy !== null || !status || !!status.dirtyFiles || !!status.ahead || !status.branch || !status.hasUpstream} className={clsx('flex shrink-0 items-center gap-1 rounded border border-accent/50 px-2 py-1 text-[10px] text-accent-fg transition-colors hover:bg-accent-bg/20 disabled:cursor-not-allowed disabled:opacity-40')} title="Create a pull request with GitHub CLI">
          {busy === 'pr' ? <Loader2 size={11} className="animate-spin" /> : <GitPullRequest size={11} />}
          PR
        </button>
        {status?.remoteUrl && <ExternalLink size={11} className="text-faint" aria-hidden="true" />}
        {(error || feedback) && <span className={clsx('basis-full truncate text-[10px]', error ? 'text-error' : 'text-success')} role="status" title={error ?? feedback ?? undefined}>{error ?? feedback}</span>}
      </div>
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" role="presentation">
          <form
            className="w-full max-w-lg rounded-lg border border-border-strong bg-surface p-4 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault()
              submitDialog()
            }}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-primary">{dialog.kind === 'commit' ? 'Commit changes' : 'Create pull request'}</h2>
              <button type="button" onClick={() => setDialog(null)} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary" aria-label="Close dialog">
                <X size={14} />
              </button>
            </div>
            {dialog.kind === 'commit' ? (
              <label className="block text-xs text-muted">
                Commit message
                <input
                  autoFocus
                  value={dialog.message}
                  onChange={(event) => setDialog({ ...dialog, message: event.target.value })}
                  className="mt-1 w-full rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none focus:border-focus"
                />
              </label>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs text-muted">
                  Title
                  <input
                    autoFocus
                    value={dialog.title}
                    onChange={(event) => setDialog({ ...dialog, title: event.target.value })}
                    className="mt-1 w-full rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none focus:border-focus"
                  />
                </label>
                <label className="block text-xs text-muted">
                  Base branch
                  <input
                    value={dialog.base}
                    onChange={(event) => setDialog({ ...dialog, base: event.target.value })}
                    placeholder="Leave blank for repository default"
                    className="mt-1 w-full rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none focus:border-focus"
                  />
                </label>
                <label className="block text-xs text-muted">
                  Description
                  <textarea
                    value={dialog.body}
                    onChange={(event) => setDialog({ ...dialog, body: event.target.value })}
                    rows={7}
                    className="mt-1 w-full resize-y rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none focus:border-focus"
                  />
                </label>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDialog(null)} className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-primary">Cancel</button>
              <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90">{dialog.kind === 'commit' ? 'Commit' : 'Create PR'}</button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
