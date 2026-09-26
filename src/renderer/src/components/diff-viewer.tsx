import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { t } from '../../../shared/i18n'
import { canDiscardGitPatch, gitDiffPaths, splitGitDiff } from '../../../shared/git-diff'
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
import { createStaleGuard } from '../utils/stale-guard'
import { filterSessionDiffFiles } from '../utils/session-diff'
import { GitConveyorActions } from './git-conveyor-actions'
import { isImagePath } from './chat-file-link'

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  content: string
  oldLine?: number
  newLine?: number
}

interface DiffFileBlock {
  patch: string
  oldPath: string
  newPath: string
  isNew: boolean
  isDeleted: boolean
  hunks: DiffLine[][]
}

interface DiffViewerProps {
  onClose?: () => void
}

export function DiffViewer({ onClose }: DiffViewerProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const [files, setFiles] = useState<DiffFileBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [stagedMode, setStagedMode] = useState(false)
  const [sessionOnly, setSessionOnly] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const discardBusy = useRef(false)
  const [discardError, setDiscardError] = useState<string | null>(null)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const workspaceId = useAppStore((state) => state.activeWorkspace?.id)
  const workspacePath = useAppStore((state) => state.activeWorkspace?.path)
  const messages = useAppStore((state) => state.messages)
  const loadGuard = useMemo(() => createStaleGuard(), [])
  const visibleFiles = useMemo(() => sessionOnly
    ? workspacePath ? filterSessionDiffFiles(files, messages, workspacePath) : []
    : files, [files, messages, sessionOnly, workspacePath])

  const loadDiff = useCallback(async () => {
    const isCurrent = loadGuard.begin()
    setLoading(true)
    setFiles([])
    setLoadError(null)
    try {
      const diff = stagedMode
        ? await window.piDesktop.files.getStagedDiff()
        : await window.piDesktop.files.getDiff()
      if (!isCurrent()) return
      setFiles(parseDiff(diff))
      setLoadError(null)
    } catch (err) {
      if (!isCurrent()) return
      setFiles([])
      setLoadError(formatIpcError(err))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [stagedMode, loadGuard])

  useEffect(() => {
    void loadDiff()
    return () => { loadGuard.begin() }
  }, [loadDiff, loadGuard, workspaceId])

  useEffect(() => {
    setExpandedFiles(new Set())
  }, [workspaceId])

  const discard = async (selected: DiffFileBlock[]): Promise<void> => {
    if (!workspaceId || stagedMode || discardBusy.current) return
    discardBusy.current = true
    setDiscarding(true)
    setDiscardError(null)
    try {
      if (await discardDiffFiles(workspaceId, selected)) await loadDiff()
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
          <div className="order-2 flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setSessionOnly((value) => !value)}
              aria-pressed={sessionOnly}
              aria-label={t('diff.sessionFilter.label')}
              title={t('diff.sessionFilter.description')}
              className={clsx(
                'rounded p-1.5 transition-colors',
                sessionOnly
                  ? 'bg-accent-bg text-accent-fg'
                  : 'text-dim hover:bg-surface-hover hover:text-secondary'
              )}
            >
              <MessageSquare size={14} aria-hidden="true" />
            </button>
            <button
              onClick={() => setStagedMode(!stagedMode)}
              className={clsx(
                'rounded px-2 py-1 text-xs transition-colors',
                stagedMode
                  ? 'bg-success-bg text-success'
                  : 'bg-card text-muted hover:text-secondary'
              )}
            >
              {stagedMode ? t('diff.stagedToggle') : t('diff.workingToggle')}
            </button>
            <button
              onClick={loadDiff}
              className="rounded p-1.5 text-dim transition-colors hover:bg-surface-hover hover:text-secondary"
              aria-label={t('diff.refreshAriaLabel')}
            >
              <RefreshCw size={14} />
            </button>
            <button
              onClick={() => {
                if (onClose) {
                  onClose()
                } else {
                  setCurrentView('chat')
                }
              }}
              className="rounded p-1.5 text-dim transition-colors hover:bg-surface-hover hover:text-secondary"
              aria-label={t('diff.closeAriaLabel')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="min-w-0 border-t border-border px-4 py-2">
          <GitConveyorActions key={workspaceId} onChanged={loadDiff}>
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
              onClick={loadDiff}
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
                key={file.newPath}
                file={file}
                expanded={expandedFiles.has(file.newPath)}
                onToggle={() => toggleFile(file.newPath)}
                onDiscard={() => void discard([file])}
                discardDisabled={discarding || stagedMode || !canDiscardGitPatch(file.patch)}
                discardTitle={stagedMode ? t('diff.discard.workingOnly')
                  : !canDiscardGitPatch(file.patch) ? t('diff.discard.unsupported')
                    : t('diff.discard.file', { path: file.newPath })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export async function discardDiffFiles(
  workspaceId: string,
  files: Pick<DiffFileBlock, 'oldPath' | 'newPath' | 'patch'>[],
): Promise<boolean> {
  const store = useAppStore.getState()
  if (!files.length || store.activeWorkspace?.id !== workspaceId) return false
  if (store.editorDirty) throw new Error(t('diff.discard.saveEditor'))
  const confirmed = await store.requestConfirm({
    title: t('diff.discard.title'),
    message: t('diff.discard.message', { files: files.map((file) => file.newPath).join('\n') }),
    confirmLabel: t('diff.discard.confirm'),
    cancelLabel: t('common.cancel'),
    danger: true,
  })
  if (!confirmed || useAppStore.getState().activeWorkspace?.id !== workspaceId) return false
  if (useAppStore.getState().editorDirty) throw new Error(t('diff.discard.saveEditor'))
  await window.piDesktop.files.discardDiff(workspaceId, files.map((file) => file.patch))
  const current = useAppStore.getState()
  if (current.activeWorkspace?.id === workspaceId && !current.editorDirty && current.previewTarget
    && files.some((file) => file.newPath === current.previewTarget!.relativePath || file.oldPath === current.previewTarget!.relativePath)) {
    await current.setPreviewTarget(null)
  }
  return true
}

export async function openDiffFile(file: Pick<DiffFileBlock, 'newPath' | 'isDeleted'>): Promise<void> {
  const store = useAppStore.getState()
  const workspace = store.activeWorkspace
  if (!workspace || file.isDeleted) return

  const name = file.newPath.split('/').pop() ?? file.newPath
  const separator = workspace.path.includes('\\') ? '\\' : '/'
  const path = workspace.path.replace(/[\\/]$/, '') + separator + file.newPath.replace(/\//g, separator)
  const opened = await store.setPreviewTarget({
    kind: isImagePath(name) ? 'image' : 'code',
    name,
    path,
    relativePath: file.newPath,
  })
  if (!opened) return
  const current = useAppStore.getState()
  if (current.chatSidePanel === 'diff') await current.setChatSidePanel(null)
  current.setCurrentView('chat')
}

function DiffFileEntry({
  file,
  expanded,
  onToggle,
  onDiscard,
  discardDisabled,
  discardTitle,
}: {
  file: DiffFileBlock
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
          <span className="text-xs text-primary truncate">{file.newPath}</span>
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
          aria-label={t('diff.discard.file', { path: file.newPath })}
          className="mr-2 shrink-0 rounded p-1.5 text-dim transition-colors hover:bg-error-bg hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Undo2 size={14} />
        </button>
        {!file.isDeleted && (
          <button
            onClick={() => void openDiffFile(file)}
            className="mr-2 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
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

function parseDiff(diffText: string): DiffFileBlock[] {
  if (!diffText.trim()) return []

  const files: DiffFileBlock[] = []
  const fileBlocks = splitGitDiff(diffText)

  for (const block of fileBlocks) {
    const lines = block.split('\n')
    const paths = gitDiffPaths(block)
    const oldPath = paths?.oldPath ?? 'unknown'
    const newPath = paths?.newPath ?? oldPath

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

    files.push({ patch: block, oldPath, newPath, isNew, isDeleted, hunks })
  }

  return files
}
