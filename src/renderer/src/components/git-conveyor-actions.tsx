import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, GitCommitHorizontal, GitPullRequest, Loader2, Upload, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import type { GitConveyorStatus } from '../../../shared/ipc-contracts'
import { formatIpcError } from '../utils/ipc-error'
import { withGitOperation } from '../utils/git-operation'
import { subscribeWorktreeRefresh } from '../utils/worktree-refresh'

type ConveyorDialog =
  | { kind: 'commit'; message: string }
  | { kind: 'pr'; title: string; body: string; base: string }

// A git identifier, not prose — stays literal (ruling on Task 25 fix item 2).
const DEFAULT_GIT_REMOTE = 'origin'

export function GitConveyorActions({ onChanged, watchDisk = false }: {
  onChanged?: () => void
  /** The bar is on screen: follow disk edits as the diff above it does. */
  watchDisk?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
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

  // Same triggers as the diff list, so a change that updates the list also
  // updates Commit/Push, and a branch switch shows the new branch at once.
  useEffect(() => subscribeWorktreeRefresh(refresh, watchDisk), [refresh, watchDisk])

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
      const result = await withGitOperation(action)
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
      setError(t('conveyor.errors.branchRequired'))
      return
    }
    if (status.dirtyFiles || status.ahead > 0 || !status.hasUpstream) {
      setError(
        status.dirtyFiles
          ? t('conveyor.errors.commitBeforePr')
          : t('conveyor.errors.pushBeforePr')
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
        setError(t('conveyor.errors.commitMessageRequired'))
        return
      }
      setDialog(null)
      void run(
        'commit',
        () => window.piDesktop.git.commit({ message }),
        (next) => t('conveyor.feedback.committed', { sha: next.head.slice(0, 8) }),
      )
      return
    }

    const title = dialog.title.trim()
    const body = dialog.body.trim()
    if (!title) {
      setError(t('conveyor.errors.prTitleRequired'))
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
      (result) => result.url ? t('conveyor.feedback.prCreatedWithUrl', { url: result.url }) : t('conveyor.feedback.prCreated'),
    )
  }

  const push = async (): Promise<void> => {
    if (!status) return
    if (status.dirtyFiles) {
      setError(t('conveyor.errors.commitBeforePush'))
      return
    }
    const target = status.upstreamBranch
      ? `${status.pushRemote ?? t('conveyor.pushConfirm.remoteFallback')}/${status.upstreamBranch}`
      : `${status.pushRemote ?? DEFAULT_GIT_REMOTE}/${status.branch ?? t('conveyor.pushConfirm.branchNameFallback')}`
    const confirmed = await requestConfirm({
      title: t('conveyor.pushConfirm.title'),
      message: t('conveyor.pushConfirm.message', { branch: status.branch ?? t('conveyor.pushConfirm.currentBranchFallback'), target }),
      confirmLabel: t('conveyor.push'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!confirmed) return
    void run(
      'push',
      () => window.piDesktop.git.push(),
      (next) => next.ahead > 0 ? t('conveyor.feedback.pushedCommits', { count: next.ahead }) : t('conveyor.feedback.branchPushed'),
    )
  }

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-start gap-1.5 lg:justify-end">
        {status && (
          <span className="basis-full mr-1 max-w-60 truncate text-[10px] text-faint sm:basis-auto" title={status.branch ?? undefined}>
            {status.dirtyFiles > 0
              ? t('conveyor.branchStatusDirty', { branch: status.branch ?? t('conveyor.detachedBranch'), count: status.dirtyFiles })
              : t('conveyor.branchStatusClean', { branch: status.branch ?? t('conveyor.detachedBranch') })}
          </span>
        )}
        <button type="button" onClick={openCommitDialog} disabled={busy !== null || !status?.dirtyFiles} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.commitButtonTitle')}>
          {busy === 'commit' ? <Loader2 size={11} className="animate-spin" /> : <GitCommitHorizontal size={11} />}
          {t('conveyor.commit')}
        </button>
        <button type="button" onClick={() => void push()} disabled={busy !== null || !status || !!status.dirtyFiles || !status.branch} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.pushButtonTitle')}>
          {busy === 'push' ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          {t('conveyor.push')}
        </button>
        <button type="button" onClick={openPrDialog} disabled={busy !== null || !status || !!status.dirtyFiles || !!status.ahead || !status.branch || !status.hasUpstream} className={clsx('flex shrink-0 items-center gap-1 rounded border border-accent/50 px-2 py-1 text-[10px] text-accent-fg transition-colors hover:bg-accent-bg/20 disabled:cursor-not-allowed disabled:opacity-40')} title={t('conveyor.prButtonTitle')}>
          {busy === 'pr' ? <Loader2 size={11} className="animate-spin" /> : <GitPullRequest size={11} />}
          {t('conveyor.prButtonLabel')}
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
              <h2 className="text-sm font-semibold text-primary">{dialog.kind === 'commit' ? t('conveyor.dialog.commitTitle') : t('conveyor.dialog.prTitle')}</h2>
              <button type="button" onClick={() => setDialog(null)} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary" aria-label={t('conveyor.dialog.closeAriaLabel')}>
                <X size={14} />
              </button>
            </div>
            {dialog.kind === 'commit' ? (
              <label className="block text-xs text-muted">
                {t('conveyor.dialog.commitMessageLabel')}
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
                  {t('conveyor.dialog.titleLabel')}
                  <input
                    autoFocus
                    value={dialog.title}
                    onChange={(event) => setDialog({ ...dialog, title: event.target.value })}
                    className="mt-1 w-full rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none focus:border-focus"
                  />
                </label>
                <label className="block text-xs text-muted">
                  {t('conveyor.dialog.baseBranchLabel')}
                  <input
                    value={dialog.base}
                    onChange={(event) => setDialog({ ...dialog, base: event.target.value })}
                    placeholder={t('conveyor.dialog.baseBranchPlaceholder')}
                    className="mt-1 w-full rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none focus:border-focus"
                  />
                </label>
                <label className="block text-xs text-muted">
                  {t('conveyor.dialog.descriptionLabel')}
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
              <button type="button" onClick={() => setDialog(null)} className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-primary">{t('common.cancel')}</button>
              <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90">{dialog.kind === 'commit' ? t('conveyor.commit') : t('conveyor.createPrButton')}</button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
