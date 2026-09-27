import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, GitCommitHorizontal, Loader2, RefreshCw, Upload, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import type { GitCommitMessageError, GitConveyorStatus, GitFileStatus } from '../../../shared/ipc-contracts'
import { t } from '../../../shared/i18n'
import { GIT_COMMIT_MESSAGE_CONFIG, GIT_CONVEYOR_NOTICE_TIMEOUT_MS } from '../../../shared/default-settings'
import { formatIpcError } from '../utils/ipc-error'
import { createStaleGuard } from '../utils/stale-guard'
import {
  applyCommitMessageSuggestion, commitMessageScope, openCommitMessageInput, switchCommitMessageInput,
  type CommitMessageInput, type LastCommitMessageSuggestion,
} from '../utils/commit-message-input'

/** Files a commit records exactly, untracked ones included. */
export interface GitCommitSelection {
  files: number
  /** Repository-root-relative paths, both sides of a rename included. */
  paths: string[]
}

type ConveyorDialog =
  | ({
    kind: 'commit'
    workspaceId: string | undefined
    pushAfter: boolean
    paths: string[] | undefined
    scope: string
  } & CommitMessageInput)

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

function commitMessageErrorText(error: GitCommitMessageError): string {
  switch (error) {
    case 'timed-out': return t('conveyor.draft.timedOut')
    case 'engine-unavailable': return t('conveyor.draft.engineUnavailable')
    case 'generation-failed': return t('conveyor.draft.failed')
  }
}

async function generateCommitMessage(paths: string[] | undefined): Promise<string> {
  const result = await window.piDesktop.git.generateCommitMessage({ force: false, ...(paths ? { paths } : {}) })
  if (result.message) return result.message
  throw new Error(result.error ? commitMessageErrorText(result.error) : t('conveyor.errors.commitMessageRequired'))
}

/** An empty message commits with the generated one, reusing a suggestion already in flight. */
export async function commitConveyorChanges(
  message: string,
  pushAfter: boolean,
  paths?: string[],
): Promise<GitConveyorStatus> {
  const workspaceId = useAppStore.getState().activeWorkspace?.id
  assertWorkspace(workspaceId)
  const commitMessage = message || await generateCommitMessage(paths)
  assertWorkspace(workspaceId)
  const committed = await window.piDesktop.git.commit({ message: commitMessage, ...(paths ? { paths } : {}) })
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

/**
 * A selection commits its listed paths, untracked ones included; a filtered
 * view can still widen it to `allSelection`. Committing the index instead (no
 * selection, or a `null` wider one) never counts untracked files: auto-staging
 * leaves them out of the commit. Push is offered only while the branch has
 * commits the remote lacks.
 */
export function gitPublishAction(
  files: Record<string, GitFileStatus>,
  status: GitConveyorStatus | null,
  selection?: GitCommitSelection,
  allSelection?: GitCommitSelection | null,
): 'commitPush' | 'push' | null {
  if (selection?.paths.length || allSelection?.paths.length) return 'commitPush'
  const commitsIndex = !selection || allSelection === null
  const hasCommitChanges = commitsIndex && Object.values(files).some((file) =>
    file.isStaged || (file.worktree !== ' ' && file.worktree !== '?' && file.worktree !== '!')
  )
  if (hasCommitChanges) return 'commitPush'
  return status?.branch && (status.ahead > 0 || !status.hasUpstream) ? 'push' : null
}

export function scheduleGitNoticeDismissal(kind: keyof typeof GIT_CONVEYOR_NOTICE_TIMEOUT_MS, dismiss: () => void): () => void {
  const timer = setTimeout(dismiss, GIT_CONVEYOR_NOTICE_TIMEOUT_MS[kind])
  return () => clearTimeout(timer)
}

export function GitConveyorActions({ children, onChanged, selection, allSelection }: {
  children?: ReactNode
  onChanged?: () => void
  /** What Commit records; absent commits the index (or the tracked changes when nothing is staged). */
  selection?: GitCommitSelection
  /** Present only while the view is filtered: the dialog's "All changes" option, where `null` commits the index. */
  allSelection?: GitCommitSelection | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const workspaceId = useAppStore((state) => state.activeWorkspace?.id)
  const commitPushRequested = useAppStore((state) => state.commitPushRequested)
  const [status, setStatus] = useState<GitConveyorStatus | null>(null)
  const [suggestion, setSuggestion] = useState<'idle' | 'generating' | GitCommitMessageError>('idle')
  const lastSuggestion = useRef<LastCommitMessageSuggestion | null>(null)
  const commitMessageId = useId()
  const requestGuard = useRef(createStaleGuard())
  const refreshGuard = useRef(createStaleGuard())
  const [busy, setBusy] = useState<'commit' | 'commitPush' | 'push' | null>(null)
  const busyRef = useRef(false)
  const [dialog, setDialog] = useState<ConveyorDialog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [statusError, dispatchStatusError] = useReducer(gitStatusErrorReducer, null)
  const visibleError = error ?? (statusError?.dismissed ? null : statusError?.message)
  const [gitFiles, setGitFiles] = useState<Record<string, GitFileStatus>>({})
  const publishAction = gitPublishAction(gitFiles, status, selection, allSelection)
  const dismissError = useCallback(() => {
    setError(null)
    setFeedback(null)
    dispatchStatusError({ type: 'dismiss' })
  }, [])

  useEffect(() => {
    if (!visibleError) return
    return scheduleGitNoticeDismissal('error', dismissError)
  }, [visibleError, dismissError])

  useEffect(() => {
    if (!feedback) return
    return scheduleGitNoticeDismissal('success', () => setFeedback(null))
  }, [feedback])

  const refresh = useCallback(async (): Promise<void> => {
    const isCurrent = refreshGuard.current.begin()
    const sameWorkspace = (): boolean => isCurrent() && useAppStore.getState().activeWorkspace?.id === workspaceId
    try {
      const [nextStatus, files] = await Promise.all([
        window.piDesktop.git.status(),
        window.piDesktop.files.getGitStatus(),
      ])
      if (!sameWorkspace()) return
      setStatus(nextStatus)
      setGitFiles(files)
      dispatchStatusError({ type: 'recovered' })
    } catch (err) {
      if (!sameWorkspace()) return
      setStatus(null)
      setGitFiles({})
      dispatchStatusError({ type: 'failed', message: formatIpcError(err) })
    }
  }, [workspaceId])

  useEffect(() => {
    setStatus(null)
    setDialog(null)
    setSuggestion('idle')
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 5000)
    const guard = refreshGuard.current
    const requests = requestGuard.current
    return () => {
      guard.begin()
      requests.begin()
      window.clearInterval(timer)
    }
  }, [refresh])

  const run = async <T,>(
    kind: 'commit' | 'commitPush' | 'push',
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

  /** Runs beside the dialog: a slow or failed suggestion never blocks a manual commit. */
  const requestSuggestion = useCallback(async (regenerated: boolean, paths: string[] | undefined, scope: string): Promise<void> => {
    const isCurrent = requestGuard.current.begin()
    const stillCurrent = (): boolean => isCurrent() && useAppStore.getState().activeWorkspace?.id === workspaceId
    setSuggestion('generating')
    try {
      const result = await window.piDesktop.git.generateCommitMessage({ force: regenerated, ...(paths ? { paths } : {}) })
      if (!stillCurrent()) return
      if (result.message) lastSuggestion.current = { scope, message: result.message }
      else if (!result.error) lastSuggestion.current = null
      setSuggestion(result.error ?? 'idle')
      setDialog((current) => current?.kind === 'commit' && current.scope === scope
        ? applyCommitMessageSuggestion(current, result.message, regenerated) : current)
    } catch {
      if (stillCurrent()) setSuggestion('generation-failed')
    }
  }, [workspaceId])

  const openCommitDialog = useCallback((pushAfter: boolean): void => {
    setError(null)
    const paths = selection?.paths.length ? [...selection.paths] : allSelection ? [...allSelection.paths] : undefined
    const scope = commitMessageScope(workspaceId, paths)
    setDialog({ kind: 'commit', ...openCommitMessageInput(lastSuggestion.current, scope), workspaceId, pushAfter, paths, scope })
    void requestSuggestion(false, paths, scope)
  }, [selection, allSelection, workspaceId, requestSuggestion])

  useEffect(() => {
    if (!commitPushRequested) return
    if (!status && !statusError) return
    useAppStore.setState({ commitPushRequested: false })
    if (!dialog && !busyRef.current && status?.branch) openCommitDialog(true)
  }, [commitPushRequested, status, statusError, dialog, openCommitDialog])

  const setCommitSelectionOnly = (selectionOnly: boolean): void => {
    if (!dialog || !selection || allSelection === undefined) return
    const paths = selectionOnly ? [...selection.paths] : allSelection ? [...allSelection.paths] : undefined
    const scope = commitMessageScope(dialog.workspaceId, paths)
    if (scope === dialog.scope) return
    setDialog({ ...dialog, ...switchCommitMessageInput(dialog, lastSuggestion.current, scope), paths, scope })
    void requestSuggestion(false, paths, scope)
  }

  const selectionScope = selection && commitMessageScope(dialog?.workspaceId, selection.paths)

  const submitDialog = (): void => {
    if (!dialog || !status) return
    const message = dialog.message.trim()
    lastSuggestion.current = null
    setDialog(null)
    void run(
      dialog.pushAfter ? 'commitPush' : 'commit',
      () => {
        assertWorkspace(dialog.workspaceId)
        return commitConveyorChanges(message, dialog.pushAfter, dialog.paths)
      },
      (next) => dialog.pushAfter
        ? next.dirtyFiles > 0
          ? t('conveyor.feedback.pushedWithLocalChanges', { count: next.dirtyFiles })
          : t('conveyor.feedback.committedAndPushed', { sha: next.head.slice(0, 8) })
        : t('conveyor.feedback.committed', { sha: next.head.slice(0, 8) }),
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
      (next) => !next ? '' : next.dirtyFiles > 0
        ? t('conveyor.feedback.pushedWithLocalChanges', { count: next.dirtyFiles })
        : next.ahead > 0 ? t('conveyor.feedback.pushedCommits', { count: next.ahead }) : t('conveyor.feedback.branchPushed'),
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
        {publishAction === 'commitPush' && (
          <button type="button" onClick={() => openCommitDialog(false)} disabled={busy !== null || !status?.branch} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.commitButtonTitle')}>
            {busy === 'commit' ? <Loader2 size={11} className="animate-spin" /> : <GitCommitHorizontal size={11} />}
            {t('conveyor.commit')}
          </button>
        )}
        {publishAction === 'commitPush' ? (
          <button type="button" onClick={() => openCommitDialog(true)} disabled={busy !== null || !status?.branch} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.commitAndPushTitle')}>
            {busy === 'commitPush' ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            {t('conveyor.commitAndPush')}
          </button>
        ) : publishAction === 'push' && (
          <button type="button" onClick={() => void push()} disabled={busy !== null || !status?.branch} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.pushButtonTitle')}>
            {busy === 'push' || busy === 'commitPush' ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            {t('conveyor.push')}
          </button>
        )}
        {visibleError ? (
          <div role="alert" className="flex min-w-0 basis-full items-start gap-2 rounded-lg border border-error/20 bg-error-bg px-3 py-2 text-xs text-error">
            <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{visibleError}</span>
            <button
              type="button"
              onClick={dismissError}
              aria-label={t('common.dismiss')}
              title={t('common.dismiss')}
              className="flex size-6 shrink-0 items-center justify-center rounded text-error/70 transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : feedback && (
          <div className="flex min-w-0 basis-full items-center gap-2 text-success">
            <span className="min-w-0 flex-1 break-words text-xs leading-relaxed" role="status">{feedback}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              aria-label={t('common.dismiss')}
              title={t('common.dismiss')}
              className="flex size-6 shrink-0 items-center justify-center rounded text-success/70 transition-colors hover:bg-success/10 hover:text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
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
              <h2 className="text-sm font-semibold text-primary">{dialog.pushAfter ? t('conveyor.commitAndPush') : t('conveyor.dialog.commitTitle')}</h2>
              <button type="button" onClick={() => setDialog(null)} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary" aria-label={t('conveyor.dialog.closeAriaLabel')}>
                <X size={14} />
              </button>
            </div>
            <div>
                {selection && allSelection !== undefined && (
                  <div role="group" aria-label={t('conveyor.dialog.scopeLabel')} className="mb-3 flex gap-1 rounded border border-border p-0.5">
                    {[true, false].map((selectionOnly) => (
                      <button
                        key={String(selectionOnly)}
                        type="button"
                        onClick={() => setCommitSelectionOnly(selectionOnly)}
                        disabled={selectionOnly && selection.paths.length === 0}
                        aria-pressed={(dialog.scope === selectionScope) === selectionOnly}
                        className={clsx(
                          'flex-1 rounded px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                          (dialog.scope === selectionScope) === selectionOnly
                            ? 'bg-accent-bg text-accent-fg'
                            : 'text-muted hover:bg-surface-hover hover:text-primary',
                        )}
                      >
                        {selectionOnly ? t('conveyor.dialog.scopeSession', { count: selection.files }) : t('conveyor.dialog.scopeAll')}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <label htmlFor={commitMessageId} className="text-xs text-muted">{t('conveyor.dialog.commitMessageLabel')}</label>
                  <button
                    type="button"
                    onClick={() => void requestSuggestion(true, dialog.paths, dialog.scope)}
                    disabled={suggestion === 'generating'}
                    aria-label={t('conveyor.draft.regenerate')}
                    title={t('conveyor.draft.regenerate')}
                    className="flex size-6 items-center justify-center rounded text-faint transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-faint"
                  >
                    <RefreshCw size={12} className={clsx(suggestion === 'generating' && 'animate-spin')} aria-hidden="true" />
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
                  className="mt-1 w-full resize-y whitespace-pre-wrap [overflow-wrap:anywhere] rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none placeholder:text-faint focus:border-focus"
                />
                {suggestion !== 'idle' && suggestion !== 'generating' && (
                  <p className="mt-1 text-[11px] text-faint" role="status">
                    {commitMessageErrorText(suggestion)}
                  </p>
                )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDialog(null)} className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-primary">{t('common.cancel')}</button>
              <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90">{dialog.pushAfter ? t('conveyor.commitAndPush') : t('conveyor.commit')}</button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
