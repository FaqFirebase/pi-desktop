import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ExternalLink, GitCommitHorizontal, GitPullRequest, Loader2, Upload, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import type { GitConveyorStatus } from '../../../shared/ipc-contracts'
import { t } from '../../../shared/i18n'
import { formatIpcError } from '../utils/ipc-error'

type ConveyorDialog =
  | { kind: 'commit'; message: string; pushAfter: boolean }
  | { kind: 'pr'; title: string; body: string; base: string }

type GitStatusError = { message: string; dismissed: boolean } | null
type GitStatusErrorAction =
  | { type: 'failed'; message: string }
  | { type: 'recovered' }
  | { type: 'dismiss' }

export function gitStatusErrorReducer(state: GitStatusError, action: GitStatusErrorAction): GitStatusError {
  switch (action.type) {
    case 'failed':
      return state?.message === action.message ? state : { message: action.message, dismissed: false }
    case 'recovered':
      return null
    case 'dismiss':
      return state ? { ...state, dismissed: true } : null
  }
}

// A git identifier, not prose — stays literal (ruling on Task 25 fix item 2).
const DEFAULT_GIT_REMOTE = 'origin'

function assertWorkspace(workspaceId: string | undefined): void {
  if (!workspaceId || useAppStore.getState().activeWorkspace?.id !== workspaceId) {
    throw new Error(t('conveyor.errors.workspaceChanged'))
  }
}

async function confirmPush(status: GitConveyorStatus): Promise<boolean> {
  const target = status.upstreamBranch
    ? `${status.pushRemote ?? t('conveyor.pushConfirm.remoteFallback')}/${status.upstreamBranch}`
    : `${status.pushRemote ?? DEFAULT_GIT_REMOTE}/${status.branch ?? t('conveyor.pushConfirm.branchNameFallback')}`
  return useAppStore.getState().requestConfirm({
    title: t('conveyor.pushConfirm.title'),
    message: t('conveyor.pushConfirm.message', { branch: status.branch ?? t('conveyor.pushConfirm.currentBranchFallback'), target }),
    confirmLabel: t('conveyor.push'),
    cancelLabel: t('common.cancel'),
    danger: true,
  })
}

export async function commitConveyorChanges(
  message: string,
  pushAfter: boolean,
): Promise<GitConveyorStatus> {
  const workspaceId = useAppStore.getState().activeWorkspace?.id
  assertWorkspace(workspaceId)
  const committed = await window.piDesktop.git.commit({ message })
  if (!pushAfter) return committed
  try {
    assertWorkspace(workspaceId)
    return await window.piDesktop.git.push()
  } catch (error) {
    throw new Error(t('conveyor.errors.committedPushFailed', {
      sha: committed.head.slice(0, 8), detail: formatIpcError(error),
    }), { cause: error })
  }
}

export function GitConveyorActions({ children, onChanged }: { children?: ReactNode; onChanged?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<GitConveyorStatus | null>(null)
  const [busy, setBusy] = useState<'commit' | 'commitPush' | 'push' | 'pr' | null>(null)
  const busyRef = useRef(false)
  const [dialog, setDialog] = useState<ConveyorDialog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [statusError, dispatchStatusError] = useReducer(gitStatusErrorReducer, null)
  const visibleError = error ?? (statusError?.dismissed ? null : statusError?.message)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.piDesktop.git.status())
      dispatchStatusError({ type: 'recovered' })
    } catch (err) {
      setStatus(null)
      dispatchStatusError({ type: 'failed', message: formatIpcError(err) })
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
    kind: 'commit' | 'commitPush' | 'push' | 'pr',
    action: () => Promise<T>,
    success: (result: T) => string,
  ): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(kind)
    setError(null)
    setFeedback(null)
    dispatchStatusError({ type: 'recovered' })
    try {
      const result = await action()
      setFeedback(success(result))
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      await refresh()
      busyRef.current = false
      setBusy(null)
      onChanged?.()
    }
  }

  const openCommitDialog = (pushAfter: boolean): void => {
    setError(null)
    setDialog({
      kind: 'commit',
      message: status?.lastCommitMessage ?? 'chore: update implementation',
      pushAfter,
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
      if (!status) return
      const message = dialog.message.trim()
      if (!message) {
        setError(t('conveyor.errors.commitMessageRequired'))
        return
      }
      setDialog(null)
      void run(
        dialog.pushAfter ? 'commitPush' : 'commit',
        () => commitConveyorChanges(message, dialog.pushAfter),
        (next) => dialog.pushAfter
          ? t('conveyor.feedback.committedAndPushed', { sha: next.head.slice(0, 8) })
          : t('conveyor.feedback.committed', { sha: next.head.slice(0, 8) }),
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
    const workspaceId = useAppStore.getState().activeWorkspace?.id
    void run(
      'push',
      async () => {
        if (!(await confirmPush(status))) return null
        assertWorkspace(workspaceId)
        return window.piDesktop.git.push()
      },
      (next) => !next ? '' : next.ahead > 0 ? t('conveyor.feedback.pushedCommits', { count: next.ahead }) : t('conveyor.feedback.branchPushed'),
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
        {children}
        {!!status?.dirtyFiles && (
          <>
            <button type="button" onClick={() => openCommitDialog(false)} disabled={busy !== null || !status.branch} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.commitButtonTitle')}>
              {busy === 'commit' ? <Loader2 size={11} className="animate-spin" /> : <GitCommitHorizontal size={11} />}
              {t('conveyor.commit')}
            </button>
            <button type="button" onClick={() => openCommitDialog(true)} disabled={busy !== null || !status.branch} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.commitAndPushTitle')}>
              {busy === 'commitPush' ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
              {t('conveyor.commitAndPush')}
            </button>
          </>
        )}
        {(!status?.dirtyFiles || status.ahead > 0 || (!status.hasUpstream && !!status.head)) && (
          <button type="button" onClick={() => void push()} disabled={busy !== null || !status?.branch} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.pushButtonTitle')}>
            {busy === 'push' || busy === 'commitPush' ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            {t('conveyor.push')}
          </button>
        )}
        <button type="button" onClick={openPrDialog} disabled={busy !== null || !status || !!status.dirtyFiles || !!status.ahead || !status.branch || !status.hasUpstream} className={clsx('flex shrink-0 items-center gap-1 rounded border border-accent/50 px-2 py-1 text-[10px] text-accent-fg transition-colors hover:bg-accent-bg/20 disabled:cursor-not-allowed disabled:opacity-40')} title={t('conveyor.prButtonTitle')}>
          {busy === 'pr' ? <Loader2 size={11} className="animate-spin" /> : <GitPullRequest size={11} />}
          {t('conveyor.prButtonLabel')}
        </button>
        {status?.remoteUrl && <ExternalLink size={11} className="text-faint" aria-hidden="true" />}
        {visibleError ? (
          <div role="alert" className="flex min-w-0 basis-full items-start gap-2 rounded-lg border border-error/20 bg-error-bg px-3 py-2 text-xs text-error">
            <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{visibleError}</span>
            <button
              type="button"
              onClick={() => {
                setError(null)
                setFeedback(null)
                dispatchStatusError({ type: 'dismiss' })
              }}
              aria-label={t('common.dismiss')}
              title={t('common.dismiss')}
              className="flex size-6 shrink-0 items-center justify-center rounded text-error/70 transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : feedback && <span className="basis-full truncate text-[10px] text-success" role="status" title={feedback}>{feedback}</span>}
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
              <h2 className="text-sm font-semibold text-primary">{dialog.kind === 'commit' ? dialog.pushAfter ? t('conveyor.commitAndPush') : t('conveyor.dialog.commitTitle') : t('conveyor.dialog.prTitle')}</h2>
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
              <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90">{dialog.kind === 'commit' ? dialog.pushAfter ? t('conveyor.commitAndPush') : t('conveyor.commit') : t('conveyor.createPrButton')}</button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
