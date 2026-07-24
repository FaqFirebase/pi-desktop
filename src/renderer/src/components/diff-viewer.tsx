import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { clsx } from 'clsx'
import {
  GitCompare,
  File,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  X,
  Loader2,
} from 'lucide-react'

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  content: string
  oldLine?: number
  newLine?: number
}

interface DiffFileBlock {
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
  const [files, setFiles] = useState<DiffFileBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [stagedMode, setStagedMode] = useState(false)
  const setCurrentView = useAppStore((state) => state.setCurrentView)

  const loadDiff = useCallback(async () => {
    setLoading(true)
    try {
      const diff = stagedMode
        ? await window.piDesktop.files.getStagedDiff()
        : await window.piDesktop.files.getDiff()
      setFiles(parseDiff(diff))
    } catch {
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [stagedMode])

  useEffect(() => {
    loadDiff()
  }, [loadDiff])

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
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <GitCompare size={16} className="text-muted" />
          <h2 className="text-sm font-medium text-primary">Diff Viewer</h2>
          <span className="rounded-full bg-card px-2 py-0.5 text-xs text-dim">
            {files.length} file{files.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setStagedMode(!stagedMode)}
            className={clsx(
              'rounded px-2 py-1 text-xs transition-colors',
              stagedMode
                ? 'bg-success-bg text-success'
                : 'bg-card text-muted hover:text-secondary'
            )}
          >
            {stagedMode ? 'Staged' : 'Working'}
          </button>
          <button
            onClick={loadDiff}
            className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
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
            className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-dim" />
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-dim">
            <GitCompare size={32} className="mb-3 text-faint" />
            <p className="text-sm">No changes</p>
            <p className="mt-1 text-xs text-faint">
              {stagedMode ? 'No staged changes' : 'Working tree is clean'}
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {files.map((file) => (
              <DiffFileEntry
                key={file.newPath}
                file={file}
                expanded={expandedFiles.has(file.newPath)}
                onToggle={() => toggleFile(file.newPath)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DiffFileEntry({
  file,
  expanded,
  onToggle,
}: {
  file: DiffFileBlock
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const additions = file.hunks.flat().filter((l) => l.type === 'add').length
  const deletions = file.hunks.flat().filter((l) => l.type === 'remove').length
  // Diff body scales with the Code Editor font-size setting (like the code viewer).
  const codeFontSize = useAppStore(
    (state) => state.settingsDraft.codeEditorFontSize ?? state.settings?.codeEditorFontSize ?? DEFAULT_SETTINGS.codeEditorFontSize
  )

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* File header */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 bg-surface/50 hover:bg-surface-hover/50 transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <File size={14} className="shrink-0 text-dim" />
        <span className="text-xs text-primary truncate">{file.newPath}</span>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {file.isNew && (
            <span className="rounded bg-success-bg px-1.5 py-0.5 text-success">NEW</span>
          )}
          {file.isDeleted && (
            <span className="rounded bg-error-bg px-1.5 py-0.5 text-error">DELETED</span>
          )}
          {additions > 0 && (
            <span className="text-success">+{additions}</span>
          )}
          {deletions > 0 && (
            <span className="text-error">-{deletions}</span>
          )}
        </div>
      </button>

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
  const fileBlocks = diffText.split(/^diff --git /m).filter(Boolean)

  for (const block of fileBlocks) {
    const lines = block.split('\n')

    // Parse file paths from "a/path b/path"
    const pathLine = lines[0] ?? ''
    const pathMatch = pathLine.match(/^a\/(.+?) b\/(.+)$/)
    const oldPath = pathMatch?.[1] ?? 'unknown'
    const newPath = pathMatch?.[2] ?? oldPath

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

    files.push({ oldPath, newPath, isNew, isDeleted, hunks })
  }

  return files
}
