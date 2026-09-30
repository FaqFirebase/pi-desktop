import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ExternalLink, GitCommitHorizontal, GitPullRequest, Loader2, Sparkles, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import type { GitCommitMessageError, GitConveyorStatus, GitFileStatus } from '../../../shared/ipc-contracts'
import { t } from '../../../shared/i18n'
import { GIT_COMMIT_MESSAGE_CONFIG, GIT_CONVEYOR_NOTICE_TIMEOUT_MS } from '../../../shared/default-settings'
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
    pushAfter: boolean
    paths: string[] | undefined
    scope: string
  } & CommitMessageInput)
  | { kind: 'pr'; title: string; body: string; base: string }

type ConveyorAction = 'commit' | 'commitPush' | 'push' | 'pr'

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
/** `git status --porcelain` marks an untracked file with this code in both columns. */
const UNTRACKED_STATUS = '?'
// Markdown section headings prefilled in a new pull request description.
const PULL_REQUEST_BODY_TEMPLATE = '## Summary\n\n## Verification\n'
const DIALOG_FIELD = 'mt-1 w-full rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none focus:border-focus'

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

export interface ConveyorCommitResult {
  status: GitConveyorStatus
  pushed: boolean
}

/**
 * Commits with the message the user typed or accepted. A message is only ever
 * generated from an explicit Suggest click, never implicitly on commit.
 * Pushing afterwards follows the standalone Push rules: it needs a clean
 * working tree and the same confirmation. A declined confirmation keeps the
 * commit local.
 */
export async function commitConveyorChanges(
  message: string,
  pushAfter: boolean,
  paths?: string[],
): Promise<ConveyorCommitResult> {
  if (!message.trim()) throw new Error(t('conveyor.errors.commitMessageRequired'))
  const workspaceId = useAppStore.getState().activeWorkspace?.id
  assertWorkspace(workspaceId)
  const committed = await window.piDesktop.git.commit({ message, ...(paths ? { paths } : {}) })
  if (!pushAfter) return { status: committed, pushed: false }
  try {
    if (committed.dirtyFiles > 0) throw new Error(t('conveyor.errors.commitBeforePush'))
    assertWorkspace(workspaceId)
    if (!(await confirmPush(committed))) return { status: committed, pushed: false }
    assertWorkspace(workspaceId)
    return { status: await window.piDesktop.git.push(), pushed: true }
  } catch (error) {
    throw new Error(t('conveyor.errors.committedPushFailed', {
      sha: committed.head.slice(0, 8), detail: formatIpcError(error),
    }), { cause: error })
  }
}

/** Staged entries and tracked changes; untracked files never reach a commit on their own. */
function isCommittable(file: GitFileStatus | undefined): boolean {
  return !!file && (file.isStaged || (file.worktree !== ' ' && file.worktree !== UNTRACKED_STATUS && file.worktree !== '!'))
}

/**
 * A selection commits only the committable files among its listed paths;
 * without one, the index or the tracked changes. Push is offered only while
 * the working tree is clean and the branch has commits the remote lacks (or
 * is not published yet).
 */
export function gitPublishAction(
  files: Record<string, GitFileStatus>,
  status: GitConveyorStatus | null,
  selection?: GitCommitSelection,
): 'commitPush' | 'push' | null {
  const candidates = selection ? selection.paths.map((path) => files[path]) : Object.values(files)
  if (candidates.some(isCommittable)) return 'commitPush'
  return status?.branch && status.dirtyFiles === 0 && (status.ahead > 0 || !status.hasUpstream) ? 'push' : null
}

export function scheduleGitNoticeDismissal(kind: keyof typeof GIT_CONVEYOR_NOTICE_TIMEOUT_MS, dismiss: () => void): () => void {
  const timer = setTimeout(dismiss, GIT_CONVEYOR_NOTICE_TIMEOUT_MS[kind])
  return () => clearTimeout(timer)
}

export function GitConveyorActions({ children, onChanged, selection, shortcutActive = false, watchDisk = false }: {
  shortcutActive?: boolean
  /** The bar is on screen: follow disk edits as the diff above it does. */
  watchDisk?: boolean
  children?: ReactNode
  onChanged?: () => void
  /** What Commit records; absent commits the index (or the tracked changes when nothing is staged). */
  selection?: GitCommitSelection
}): React.JSX.Element {
  const { t } = useTranslation()
  const workspaceId = useAppStore((state) => state.activeWorkspace?.id)
  const shortcutRequest = useAppStore((state) => state.diffShortcutRequest)
  const [status, setStatus] = useState<GitConveyorStatus | null>(null)
  const [suggestion, setSuggestion] = useState<'idle' | 'generating' | GitCommitMessageError>('idle')
  const lastSuggestion = useRef<LastCommitMessageSuggestion | null>(null)
  const commitMessageId = useId()
  const requestGuard = useRef(createStaleGuard())
  const refreshGuard = useRef(createStaleGuard())
  const [busy, setBusy] = useState<ConveyorAction | null>(null)
  const busyRef = useRef(false)
  const [dialog, setDialog] = useState<ConveyorDialog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [statusError, dispatchStatusError] = useReducer(gitStatusErrorReducer, null)
  const visibleError = error ?? (statusError?.dismissed ? null : statusError?.message)
  const [gitFiles, setGitFiles] = useState<Record<string, GitFileStatus>>({})
  const publishAction = gitPublishAction(gitFiles, status, selection)
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

  const refresh = useCallback(async (): Promise<GitConveyorStatus | null> => {
    const isCurrent = refreshGuard.current.begin()
    const sameWorkspace = (): boolean => isCurrent() && useAppStore.getState().activeWorkspace?.id === workspaceId
    try {
      const [nextStatus, files] = await Promise.all([
        window.piDesktop.git.status(),
        window.piDesktop.files.getGitStatus(),
      ])
      if (!sameWorkspace()) return null
      setStatus(nextStatus)
      setGitFiles(files)
      dispatchStatusError({ type: 'recovered' })
      return nextStatus
    } catch (err) {
      if (!sameWorkspace()) return null
      setStatus(null)
      setGitFiles({})
      dispatchStatusError({ type: 'failed', message: formatIpcError(err) })
      return null
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

  // Same triggers as the diff list, so a change that updates the list also
  // updates Commit/Push, and a branch switch shows the new branch at once.
  useEffect(() => subscribeWorktreeRefresh(refresh, watchDisk), [refresh, watchDisk])

  const run = async <T,>(
    kind: ConveyorAction,
    action: () => Promise<T>,
    success: (result: T) => string | null,
  ): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(kind)
    setError(null)
    setFeedback(null)
    dispatchStatusError({ type: 'recovered' })
    try {
      const result = await withGitOperation(action)
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

  const openCommitDialog = useCallback((pushAfter: boolean): void => {
    setError(null)
    if (selection && selection.paths.length === 0) return
    const paths = selection ? [...selection.paths] : undefined
    const scope = commitMessageScope(workspaceId, paths)
    setDialog({ kind: 'commit', ...openCommitMessageInput(lastSuggestion.current, scope), workspaceId, pushAfter, paths, scope })
  }, [selection, workspaceId])

  useEffect(() => {
    if (!shortcutActive || shortcutRequest !== 'commitPush') return
    useAppStore.setState({ diffShortcutRequest: null })
    if (!dialog && !busyRef.current && status?.branch && publishAction === 'commitPush') openCommitDialog(true)
  }, [shortcutActive, shortcutRequest, dialog, status, publishAction, openCommitDialog])

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
      body: PULL_REQUEST_BODY_TEMPLATE,
      base: status.baseBranch ?? '',
    })
  }

  const submitPullRequest = (pr: Extract<ConveyorDialog, { kind: 'pr' }>): void => {
    const title = pr.title.trim()
    const body = pr.body.trim()
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
          ...(pr.base.trim() ? { base: pr.base.trim() } : {}),
        })
        if (result.url) void window.piDesktop.system.openExternal(result.url)
        return result
      },
      (result) => result.url ? t('conveyor.feedback.prCreatedWithUrl', { url: result.url }) : t('conveyor.feedback.prCreated'),
    )
  }

  const submitDialog = (): void => {
    if (!dialog || !status) return
    if (dialog.kind === 'pr') {
      submitPullRequest(dialog)
      return
    }
    const message = dialog.message.trim()
    if (!message) return
    lastSuggestion.current = null
    setDialog(null)
    void run(
      dialog.pushAfter ? 'commitPush' : 'commit',
      () => {
        assertWorkspace(dialog.workspaceId)
        return commitConveyorChanges(message, dialog.pushAfter, dialog.paths)
      },
      ({ status: next, pushed }) => pushed
        ? t('conveyor.feedback.committedAndPushed', { sha: next.head.slice(0, 8) })
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
      (next) => !next ? null
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
        <button type="button" onClick={openPrDialog} disabled={busy !== null || !status || !!status.dirtyFiles || !!status.ahead || !status.branch || !status.hasUpstream} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={t('conveyor.prButtonTitle')}>
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
              <h2 className="text-sm font-semibold text-primary">
                {dialog.kind === 'pr' ? t('conveyor.dialog.prTitle') : dialog.pushAfter ? t('conveyor.commitAndPush') : t('conveyor.dialog.commitTitle')}
              </h2>
              <button type="button" onClick={() => setDialog(null)} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary" aria-label={t('conveyor.dialog.closeAriaLabel')}>
                <X size={14} />
              </button>
            </div>
            {dialog.kind === 'pr' ? (
              <div className="space-y-2">
                <label className="block text-xs text-muted">
                  {t('conveyor.dialog.titleLabel')}
                  <input
                    autoFocus
                    value={dialog.title}
                    onChange={(event) => setDialog({ ...dialog, title: event.target.value })}
                    className={DIALOG_FIELD}
                  />
                </label>
                <label className="block text-xs text-muted">
                  {t('conveyor.dialog.baseBranchLabel')}
                  <input
                    value={dialog.base}
                    onChange={(event) => setDialog({ ...dialog, base: event.target.value })}
                    placeholder={t('conveyor.dialog.baseBranchPlaceholder')}
                    className={DIALOG_FIELD}
                  />
                </label>
                <label className="block text-xs text-muted">
                  {t('conveyor.dialog.descriptionLabel')}
                  <textarea
                    value={dialog.body}
                    onChange={(event) => setDialog({ ...dialog, body: event.target.value })}
                    rows={7}
                    className={`${DIALOG_FIELD} resize-y`}
                  />
                </label>
              </div>
            ) : (
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
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDialog(null)} className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-primary">{t('common.cancel')}</button>
              <button
                type="submit"
                disabled={dialog.kind === 'commit' && !dialog.message.trim()}
                title={dialog.kind === 'commit' && !dialog.message.trim() ? t('conveyor.errors.commitMessageRequired') : undefined}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-accent"
              >
                {dialog.kind === 'pr' ? t('conveyor.createPrButton') : dialog.pushAfter ? t('conveyor.commitAndPush') : t('conveyor.commit')}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
