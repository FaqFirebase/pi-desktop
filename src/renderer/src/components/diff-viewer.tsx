import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { t } from '../../../shared/i18n'
import {
  canDiscardGitPatch, gitDiffHeaderNames, gitDiffPaths, splitGitDiff, type GitDiffPaths,
} from '../../../shared/git-diff'
import { clsx } from 'clsx'
import {
  AlertTriangle,
  GitCompare,
  MessageSquare,
  Undo2,
  FilePenLine,
  File,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  X,
  Loader2,
} from 'lucide-react'
import { formatIpcError } from '../utils/ipc-error'
import { withGitOperation } from '../utils/git-operation'
import { createStaleGuard } from '../utils/stale-guard'
import { subscribeWorktreeRefresh } from '../utils/worktree-refresh'
import { filterSessionDiffFiles } from '../utils/session-diff'
import { isChatVisible, isGlobalWorkflowOpen } from '../hooks'
import { GitConveyorActions, type GitCommitSelection } from './git-conveyor-actions'
import { openFilePreview } from './chat-file-link'
import { joinWorkspacePath, workspaceRelativeGitPath } from '../utils/workspace-path'

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  content: string
  oldLine?: number
  newLine?: number
}

interface DiffFileBlock {
  patch: string
  /**
   * Repository-root paths of both sides, the same strings as the status keys.
   * Null when Git names a path that cannot be read exactly (not UTF-8): such
   * a file is shown, but never committed, discarded, or opened by a guess.
   */
  paths: GitDiffPaths | null
  /** The new path, or Git's own header text when the paths cannot be read. */
  label: string
  isNew: boolean
  isDeleted: boolean
  hunks: DiffLine[][]
}

// Same shape as the Commit/Push/PR buttons in GitConveyorActions so both header rows line up.
const TOOLBAR_BUTTON = 'flex shrink-0 items-center justify-center gap-1 rounded border px-1.5 py-1 text-[10px] transition-colors'

interface DiffViewerProps {
  onClose?: () => void
}

export function DiffViewer({ onClose }: DiffViewerProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const [files, setFiles] = useState<DiffFileBlock[]>([])
  const [gitPrefix, setGitPrefix] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [stagedMode, setStagedMode] = useState(false)
  // Off by default: a fresh chat has touched no files yet, so the filter would hide every change.
  const [sessionOnly, setSessionOnly] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const discardBusy = useRef(false)
  const [discardError, setDiscardError] = useState<string | null>(null)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const shortcutActive = useAppStore((state) =>
    state.currentView === (onClose ? 'chat' : 'diff') &&
    !(state.workflowPanelOpen && !state.workflowPanelFilter && state.workflowPanelWorkspaceId === null))
  const shortcutRequest = useAppStore((state) => state.diffShortcutRequest)
  useEffect(() => {
    if (!shortcutActive || shortcutRequest !== 'review') return
    setSessionOnly(true)
    setStagedMode(false)
    useAppStore.setState({ diffShortcutRequest: null })
  }, [shortcutActive, shortcutRequest])
  const workspaceId = useAppStore((state) => state.activeWorkspace?.id)
  const workspacePath = useAppStore((state) => state.activeWorkspace?.path)
  // The chat's diff pane stays mounted while another view hides the chat; the
  // Diff view page is mounted only while it is the current view.
  const visible = useAppStore((state) => onClose ? isChatVisible(state) : !isGlobalWorkflowOpen(state))
  const messages = useAppStore((state) => state.messages)
  const loadGuard = useMemo(() => createStaleGuard(), [])
  const visibleFiles = useMemo(() => sessionOnly
    ? workspacePath ? filterSessionDiffFiles(files, messages, workspacePath, gitPrefix) : []
    : files, [files, gitPrefix, messages, sessionOnly, workspacePath])
  // Commit is limited to the files on screen. The staged view without a filter
  // commits the index it shows.
  const commitSelection = useMemo(() => stagedMode && !sessionOnly ? undefined : diffCommitSelection(visibleFiles),
    [sessionOnly, stagedMode, visibleFiles])

  // A background load keeps the current list on screen until the new one
  // arrives, so automatic refreshes never flash the list empty.
  const loadDiff = useCallback(async (showLoading: boolean) => {
    const isCurrent = loadGuard.begin()
    if (showLoading) {
      setLoading(true)
      setFiles([])
      setLoadError(null)
    }
    try {
      const [diff, prefix] = await Promise.all([
        stagedMode ? window.piDesktop.files.getStagedDiff() : window.piDesktop.files.getDiff(),
        window.piDesktop.files.getGitPrefix(),
      ])
      if (!isCurrent()) return
      setGitPrefix(prefix)
      setFiles(parseDiff(diff))
      setLoadError(null)
    } catch (err) {
      if (!isCurrent()) return
      setFiles([])
      setLoadError(formatIpcError(err))
    } finally {
      // Also on a background load: it may have superseded a visible one.
      if (isCurrent()) setLoading(false)
    }
  }, [stagedMode, loadGuard])
  const reloadDiff = useCallback(() => loadDiff(true), [loadDiff])
  const refreshDiff = useCallback(() => loadDiff(false), [loadDiff])

  useEffect(() => {
    void reloadDiff()
    return () => { loadGuard.begin() }
  }, [reloadDiff, loadGuard, workspaceId])

  useEffect(() => subscribeWorktreeRefresh(refreshDiff, visible), [refreshDiff, visible])

  // Disk edits made while the pane was hidden were not watched; catch up on return.
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) void refreshDiff()
    wasVisible.current = visible
  }, [visible, refreshDiff])

  useEffect(() => {
    setExpandedFiles(new Set())
  }, [workspaceId])

  const discard = async (selected: DiffFileBlock[]): Promise<void> => {
    if (!workspaceId || stagedMode || discardBusy.current) return
    discardBusy.current = true
    setDiscarding(true)
    setDiscardError(null)
    try {
      if (await discardDiffFiles(workspaceId, selected, gitPrefix)) await reloadDiff()
    } catch (error) {
      setDiscardError(formatIpcError(error))
    } finally {
      discardBusy.current = false
      setDiscarding(false)
    }
  }

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border">
        <div className="flex min-h-[calc(var(--spacing)*8-1px)] flex-wrap items-center gap-2 px-4 py-0.5">
          <div className="order-1 flex min-w-0 flex-1 items-center gap-2">
            <GitCompare size={16} className="shrink-0 text-muted" />
            <h2 className="truncate text-sm font-medium text-primary">{t('diff.heading')}</h2>
            <span className="shrink-0 rounded-full bg-card px-2 py-0.5 text-xs text-dim">
              {t('diff.fileCount', { count: visibleFiles.length })}
            </span>
          </div>
          <div className="order-2 flex shrink-0 items-stretch gap-1.5">
            <button
              type="button"
              onClick={() => setSessionOnly((value) => !value)}
              aria-pressed={sessionOnly}
              aria-label={t('diff.sessionFilter.label')}
              title={t('diff.sessionFilter.description')}
              className={clsx(
                TOOLBAR_BUTTON,
                sessionOnly
                  ? 'border-accent/50 bg-accent-bg/20 text-accent-fg'
                  : 'border-border text-muted hover:bg-surface-hover hover:text-primary'
              )}
            >
              <MessageSquare size={11} aria-hidden="true" />
            </button>
            <button
              onClick={() => setStagedMode(!stagedMode)}
              className={clsx(
                TOOLBAR_BUTTON,
                'px-2',
                stagedMode
                  ? 'border-success/50 bg-success-bg text-success'
                  : 'border-border text-muted hover:bg-surface-hover hover:text-primary'
              )}
            >
              {stagedMode ? t('diff.stagedToggle') : t('diff.workingToggle')}
            </button>
            <button
              onClick={reloadDiff}
              className={clsx(TOOLBAR_BUTTON, 'border-border text-muted hover:bg-surface-hover hover:text-primary')}
              aria-label={t('diff.refreshAriaLabel')}
            >
              <RefreshCw size={11} />
            </button>
            <button
              onClick={() => {
                if (onClose) {
                  onClose()
                } else {
                  setCurrentView('chat')
                }
              }}
              className="ml-1 rounded p-1 text-dim hover:text-secondary"
              aria-label={t('diff.closeAriaLabel')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="flex min-h-8 min-w-0 flex-col justify-center border-t border-border px-4 py-0.5">
          <GitConveyorActions key={workspaceId} onChanged={reloadDiff} selection={commitSelection} shortcutActive={shortcutActive && !loading && !loadError} watchDisk={visible}>
            <button
              type="button"
              onClick={() => void discard(visibleFiles)}
              disabled={loading || discarding || stagedMode || visibleFiles.length === 0 || visibleFiles.some((file) => !canDiscardGitPatch(file.patch))}
              title={stagedMode ? t('diff.discard.workingOnly') : t('diff.discard.all')}
              aria-label={t('diff.discard.all')}
              className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:bg-error-bg hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
            >
              {discarding ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
              {t('diff.discard.confirm')}
            </button>
          </GitConveyorActions>
        </div>
      </div>

      {discardError && <p role="alert" className="shrink-0 px-4 py-2 text-xs text-error">{discardError}</p>}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-dim" />
          </div>
        ) : loadError !== null ? (
          <div className="flex flex-col items-center justify-center py-12 text-dim">
            <AlertTriangle size={32} className="mb-3 text-warning" />
            <p className="text-sm text-secondary">{t('diff.loadErrorTitle')}</p>
            <p className="mt-1 max-w-md break-words px-4 text-center text-xs text-faint">{loadError}</p>
            <button
              onClick={reloadDiff}
              className="mt-3 rounded bg-card px-3 py-1 text-xs text-secondary transition-colors hover:bg-surface-hover"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-dim">
            <GitCompare size={32} className="mb-3 text-faint" />
            <p className="text-sm">{sessionOnly ? t('diff.sessionFilter.noMatches') : t('diff.noChanges')}</p>
            <p className="mt-1 max-w-md px-4 text-center text-xs text-faint">
              {sessionOnly
                ? t('diff.sessionFilter.description')
                : stagedMode ? t('diff.noStagedChanges') : t('diff.workingTreeClean')}
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {visibleFiles.map((file) => (
              <DiffFileEntry
                key={file.label}
                file={file}
                gitPrefix={gitPrefix}
                expanded={expandedFiles.has(file.label)}
                onToggle={() => toggleFile(file.label)}
                onDiscard={() => void discard([file])}
                discardDisabled={discarding || stagedMode || !canDiscardGitPatch(file.patch)}
                discardTitle={stagedMode ? t('diff.discard.workingOnly')
                  : !canDiscardGitPatch(file.patch) ? t('diff.discard.unsupported')
                    : t('diff.discard.file', { path: file.label })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** What Commit records for the files on screen: both sides of every readable patch. */
export function diffCommitSelection(files: readonly Pick<DiffFileBlock, 'paths'>[]): GitCommitSelection {
  const paths = files.flatMap((file) => file.paths ? [file.paths.oldPath, file.paths.newPath] : [])
  return { files: files.length, paths: [...new Set(paths)] }
}

export async function discardDiffFiles(
  workspaceId: string,
  files: Pick<DiffFileBlock, 'paths' | 'label' | 'patch'>[],
  gitPrefix: string,
): Promise<boolean> {
  const store = useAppStore.getState()
  if (!files.length || store.activeWorkspace?.id !== workspaceId) return false
  if (store.editorDirty) throw new Error(t('diff.discard.saveEditor'))
  const confirmed = await store.requestConfirm({
    title: t('diff.discard.title', { count: files.length }),
    message: t('diff.discard.message', { count: files.length, files: files.map((file) => file.label).join('\n') }),
    confirmLabel: t('diff.discard.confirm'),
    cancelLabel: t('common.cancel'),
    danger: true,
  })
  if (!confirmed || useAppStore.getState().activeWorkspace?.id !== workspaceId) return false
  if (useAppStore.getState().editorDirty) throw new Error(t('diff.discard.saveEditor'))
  await withGitOperation(() => window.piDesktop.files.discardDiff(workspaceId, files.map((file) => file.patch)))
  const current = useAppStore.getState()
  const opened = current.previewTarget?.relativePath
  if (current.activeWorkspace?.id === workspaceId && !current.editorDirty && opened !== undefined
    && files.some((file) => file.paths && [file.paths.newPath, file.paths.oldPath]
      .some((path) => workspaceRelativeGitPath(path, gitPrefix) === opened))) {
    await current.setPreviewTarget(null)
  }
  return true
}

type OpenableDiffFile = Pick<DiffFileBlock, 'paths' | 'isDeleted'>

/** The file's workspace-relative path, or null when it is deleted, unreadable, or outside the workspace. */
function openableDiffPath(file: OpenableDiffFile, gitPrefix: string): string | null {
  return file.isDeleted || !file.paths ? null : workspaceRelativeGitPath(file.paths.newPath, gitPrefix)
}

/** Open a diff file in the chat preview; `gitPrefix` maps its repository-root path onto the workspace. */
export async function openDiffFile(file: OpenableDiffFile, gitPrefix: string): Promise<void> {
  const workspace = useAppStore.getState().activeWorkspace
  const relativePath = openableDiffPath(file, gitPrefix)
  if (!workspace || relativePath === null) return
  await openFilePreview({
    name: relativePath.split('/').pop() ?? relativePath,
    path: joinWorkspacePath(workspace.path, relativePath),
    relativePath,
  })
}

function DiffFileEntry({
  file,
  gitPrefix,
  expanded,
  onToggle,
  onDiscard,
  discardDisabled,
  discardTitle,
}: {
  file: DiffFileBlock
  gitPrefix: string
  expanded: boolean
  onToggle: () => void
  onDiscard: () => void
  discardDisabled: boolean
  discardTitle: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const additions = file.hunks.flat().filter((l) => l.type === 'add').length
  const deletions = file.hunks.flat().filter((l) => l.type === 'remove').length
  // Diff body scales with the Code Editor font-size setting (like the code viewer).
  const codeFontSize = useAppStore(
    (state) => state.settingsDraft.codeEditorFontSize ?? state.settings?.codeEditorFontSize ?? DEFAULT_SETTINGS.codeEditorFontSize
  )

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* File header */}
      <div className="flex items-center bg-surface/50">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 hover:bg-surface-hover/50 transition-colors"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <File size={14} className="shrink-0 text-dim" />
          <span className="text-xs text-primary truncate">{file.label}</span>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {file.isNew && (
              <span className="rounded bg-success-bg px-1.5 py-0.5 text-success">{t('diff.newFileBadge')}</span>
            )}
            {file.isDeleted && (
              <span className="rounded bg-error-bg px-1.5 py-0.5 text-error">{t('diff.deletedFileBadge')}</span>
            )}
            {additions > 0 && (
              <span className="text-success">+{additions}</span>
            )}
            {deletions > 0 && (
              <span className="text-error">-{deletions}</span>
            )}
          </div>
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={discardDisabled}
          title={discardTitle}
          aria-label={t('diff.discard.file', { path: file.label })}
          className="mr-2 shrink-0 rounded p-1.5 text-dim transition-colors hover:bg-error-bg hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Undo2 size={14} />
        </button>
        {openableDiffPath(file, gitPrefix) !== null && (
          <button
            onClick={() => void openDiffFile(file, gitPrefix)}
            className="mr-2 flex shrink-0 items-center justify-center rounded p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
            title={t('diff.openFile')}
            aria-label={t('diff.openFile')}
          >
            <FilePenLine size={14} />
          </button>
        )}
      </div>

      {/* Diff content */}
      {expanded && (
        <div className="border-t border-border overflow-x-auto">
          <table className="font-jetbrains w-full" style={{ fontSize: `${codeFontSize}px` }}>
            <tbody>
              {file.hunks.map((hunk, hunkIdx) => (
                <DiffHunk key={hunkIdx} lines={hunk} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DiffHunk({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <>
      {lines.map((line, i) => (
        <tr
          key={`${line.type}-${line.oldLine ?? ''}-${line.newLine ?? ''}-${i}`}
          className={clsx(
            line.type === 'add' && 'bg-success-bg',
            line.type === 'remove' && 'bg-error-bg',
            line.type === 'hunk' && 'bg-accent-bg',
          )}
        >
          <td className="w-10 px-2 py-0.5 text-right text-faint select-none border-r border-border">
            {line.oldLine ?? ''}
          </td>
          <td className="w-10 px-2 py-0.5 text-right text-faint select-none border-r border-border">
            {line.newLine ?? ''}
          </td>
          <td className="w-6 px-1 py-0.5 text-center select-none">
            {line.type === 'add' && <span className="text-success">+</span>}
            {line.type === 'remove' && <span className="text-error">-</span>}
            {line.type === 'context' && <span className="text-ghost"> </span>}
            {line.type === 'hunk' && <span className="text-accent-fg">@</span>}
          </td>
          <td className="px-2 py-0.5 whitespace-pre text-secondary">
            {line.content}
          </td>
        </tr>
      ))}
    </>
  )
}

// ─── Diff Parser ─────────────────────────────────────────────────────────────

export function parseDiff(diffText: string): DiffFileBlock[] {
  if (!diffText.trim()) return []

  const files: DiffFileBlock[] = []
  const fileBlocks = splitGitDiff(diffText)

  for (const block of fileBlocks) {
    const lines = block.split('\n')
    const paths = gitDiffPaths(block)
    const label = paths?.newPath ?? gitDiffHeaderNames(block)

    const isNew = lines.some((l) => l.startsWith('new file mode'))
    const isDeleted = lines.some((l) => l.startsWith('deleted file mode'))

    // Parse hunks
    const hunks: DiffLine[][] = []
    let currentHunk: DiffLine[] = []
    let oldLine = 0
    let newLine = 0

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentHunk.length > 0) hunks.push(currentHunk)
        currentHunk = []

        const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
        if (hunkMatch) {
          oldLine = parseInt(hunkMatch[1])
          newLine = parseInt(hunkMatch[2])
        }
        currentHunk.push({ type: 'hunk', content: line })
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.push({ type: 'add', content: line.slice(1), newLine })
        newLine++
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.push({ type: 'remove', content: line.slice(1), oldLine })
        oldLine++
      } else if (line.startsWith(' ')) {
        currentHunk.push({ type: 'context', content: line.slice(1), oldLine, newLine })
        oldLine++
        newLine++
      }
    }

    if (currentHunk.length > 0) hunks.push(currentHunk)

    files.push({ patch: block, paths, label, isNew, isDeleted, hunks })
  }

  return files
}
