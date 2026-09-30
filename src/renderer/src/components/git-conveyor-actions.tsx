import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, GitCommitHorizontal, GitPullRequest, Loader2, Sparkles, Upload, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import type { GitCommitMessageError, GitConveyorStatus } from '../../../shared/ipc-contracts'
import { t } from '../../../shared/i18n'
import { GIT_COMMIT_MESSAGE_CONFIG } from '../../../shared/default-settings'
import { formatIpcError } from '../utils/ipc-error'
import { withGitOperation } from '../utils/git-operation'
import { isImeComposing } from '../utils/ime-composing'
import { createStaleGuard } from '../utils/stale-guard'
import { subscribeWorktreeRefresh } from '../utils/worktree-refresh'
import {
  applyCommitMessageSuggestion, commitMessageScope, openCommitMessageInput,
  type CommitMessageInput, type LastCommitMessageSuggestion,
} from '../utils/commit-message-input'

/** Files on screen a commit is limited to; untracked ones among them stay out. */
export interface GitCommitSelection {
  files: number
  /** Repository-root-relative paths, both sides of a rename included. */
  paths: string[]
}

type ConveyorDialog =
  | ({
    kind: 'commit'
    workspaceId: string | undefined
    paths: string[] | undefined
    scope: string
  } & CommitMessageInput)
  | { kind: 'pr'; title: string; body: string; base: string }

// A git identifier, not prose — stays literal (ruling on Task 25 fix item 2).
const DEFAULT_GIT_REMOTE = 'origin'

function assertWorkspace(workspaceId: string | undefined): void {
  if (!workspaceId || useAppStore.getState().activeWorkspace?.id !== workspaceId) {
    throw new Error(t('conveyor.errors.workspaceChanged'))
  }
}

function commitMessageErrorText(error: GitCommitMessageError): string {
  switch (error) {
    case 'timed-out': return t('conveyor.draft.timedOut')
    case 'engine-unavailable': return t('conveyor.draft.engineUnavailable')
    case 'generation-failed': return t('conveyor.draft.failed')
  }
}

export function GitConveyorActions({ children, onChanged, selection, watchDisk = false }: {
  children?: ReactNode
  onChanged?: () => void
  /** What Commit records; absent commits the index (or the tracked changes when nothing is staged). */
  selection?: GitCommitSelection
  /** The bar is on screen: follow disk edits as the diff above it does. */
  watchDisk?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const requestConfirm = useAppStore((state) => state.requestConfirm)
  const workspaceId = useAppStore((state) => state.activeWorkspace?.id)
  const [status, setStatus] = useState<GitConveyorStatus | null>(null)
  const [suggestion, setSuggestion] = useState<'idle' | 'generating' | GitCommitMessageError>('idle')
  const lastSuggestion = useRef<LastCommitMessageSuggestion | null>(null)
  const commitMessageId = useId()
  const requestGuard = useRef(createStaleGuard())
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
    const requests = requestGuard.current
    return () => {
      requests.begin()
      window.clearInterval(timer)
    }
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

  /**
   * Sends the selected diff to the session model, only when the user clicks
   * Suggest. Runs beside the dialog: a slow or failed suggestion never blocks
   * a manual commit, and typing while it runs keeps the typed text.
   */
  const requestSuggestion = useCallback(async (paths: string[] | undefined, scope: string): Promise<void> => {
    const isCurrent = requestGuard.current.begin()
    // A suggestion already shown for this selection means the user wants a new one.
    const regenerated = lastSuggestion.current?.scope === scope
    setDialog((current) => current?.kind === 'commit' && current.scope === scope ? { ...current, edited: false } : current)
    const stillCurrent = (): boolean => isCurrent() && useAppStore.getState().activeWorkspace?.id === workspaceId
    setSuggestion('generating')
    try {
      const result = await window.piDesktop.git.generateCommitMessage({ force: regenerated, ...(paths ? { paths } : {}) })
      if (!stillCurrent()) return
      if (result.message) lastSuggestion.current = { scope, message: result.message }
      else if (!result.error) lastSuggestion.current = null
      setSuggestion(result.error ?? 'idle')
      setDialog((current) => current?.kind === 'commit' && current.scope === scope
        ? applyCommitMessageSuggestion(current, result.message) : current)
    } catch {
      if (stillCurrent()) setSuggestion('generation-failed')
    }
  }, [workspaceId])

  const openCommitDialog = (): void => {
    setError(null)
    if (selection && selection.paths.length === 0) return
    const paths = selection ? [...selection.paths] : undefined
    const scope = commitMessageScope(workspaceId, paths)
    setDialog({ kind: 'commit', ...openCommitMessageInput(lastSuggestion.current, scope), workspaceId, paths, scope })
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
      if (!message) return
      lastSuggestion.current = null
      setDialog(null)
      void run(
        'commit',
        () => {
          assertWorkspace(dialog.workspaceId)
          return window.piDesktop.git.commit({ message, ...(dialog.paths ? { paths: dialog.paths } : {}) })
        },
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
            {(selection?.files ?? status.dirtyFiles) > 0
              ? t('conveyor.branchStatusDirty', { branch: status.branch ?? t('conveyor.detachedBranch'), count: selection?.files ?? status.dirtyFiles })
              : t('conveyor.branchStatusClean', { branch: status.branch ?? t('conveyor.detachedBranch') })}
          </span>
        )}
        {children}
        <button type="button" onClick={openCommitDialog} disabled={busy !== null || !(selection ? selection.paths.length : status?.dirtyFiles)} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.commitButtonTitle')}>
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
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor={commitMessageId} className="text-xs text-muted">{t('conveyor.dialog.commitMessageLabel')}</label>
                  <button
                    type="button"
                    onClick={() => void requestSuggestion(dialog.paths, dialog.scope)}
                    disabled={suggestion === 'generating'}
                    title={t('conveyor.draft.suggestTitle')}
                    className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-faint transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-faint"
                  >
                    {suggestion === 'generating'
                      ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                      : <Sparkles size={12} aria-hidden="true" />}
                    {t('conveyor.draft.suggest')}
                  </button>
                </div>
                <textarea
                  id={commitMessageId}
                  autoFocus
                  rows={5}
                  wrap="soft"
                  maxLength={GIT_COMMIT_MESSAGE_CONFIG.maxMessageLength}
                  value={dialog.message}
                  placeholder={suggestion === 'generating' ? t('conveyor.draft.generating') : undefined}
                  onChange={(event) => setDialog({ ...dialog, message: event.target.value, edited: true })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isImeComposing(event.nativeEvent)) {
                      event.preventDefault()
                      event.stopPropagation()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  className="mt-1 w-full resize-y whitespace-pre-wrap [overflow-wrap:anywhere] rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none placeholder:text-faint focus:border-focus"
                />
                {suggestion !== 'idle' && suggestion !== 'generating' && (
                  <p className="mt-1 text-[11px] text-faint" role="status">
                    {commitMessageErrorText(suggestion)}
                  </p>
                )}
              </div>
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
              <button
                type="submit"
                disabled={dialog.kind === 'commit' && !dialog.message.trim()}
                title={dialog.kind === 'commit' && !dialog.message.trim() ? t('conveyor.errors.commitMessageRequired') : undefined}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-accent"
              >
                {dialog.kind === 'commit' ? t('conveyor.commit') : t('conveyor.createPrButton')}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
