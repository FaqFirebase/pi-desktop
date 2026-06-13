import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../store'
import type { FileTreeNode, GitFileStatus, FileSearchResult } from '../../../shared/ipc-contracts'
import { CodeEditor } from './code-editor'
import { clsx } from 'clsx'
import {
  FolderOpen,
  FolderClosed,
  File,
  Search,
  ChevronRight,
  ChevronDown,
  X,
  FileText,
  GitBranch,
  Loader2,
  Save,
  RotateCcw,
} from 'lucide-react'

// ─── File Tree ───────────────────────────────────────────────────────────────

// Disk changes refresh the tree instantly via the main-process watcher
// (window.piDesktop.onFileChange). This interval is only a safety net for
// environments where watching is unavailable (e.g. inotify limits), so it can
// be slow; focus also triggers an immediate refresh.
const SAFETY_POLL_MS = 15000

export function FileTree(): React.JSX.Element {
  const [tree, setTree] = useState<FileTreeNode | null>(null)
  const [gitStatus, setGitStatus] = useState<Record<string, GitFileStatus>>({})
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  const loadTree = useCallback(async (showLoading: boolean) => {
    if (showLoading) setLoading(true)
    try {
      const [treeData, status, branch] = await Promise.all([
        window.piDesktop.files.getTree(4),
        window.piDesktop.files.getGitStatus(),
        window.piDesktop.files.getGitBranch(),
      ])
      setTree(treeData)
      setGitStatus(status)
      setGitBranch(branch)
    } catch {
      // Silent failure
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTree(true)

    // Primary path: refresh the instant the main process reports a disk change
    // in the active workspace.
    const unsubscribe = window.piDesktop.onFileChange(() => {
      if (!document.hidden) void loadTree(false)
    })

    const interval = window.setInterval(() => {
      // Skip polling while the window is hidden/minimized; the 'focus' listener
      // below refreshes immediately when the user returns.
      if (!document.hidden) void loadTree(false)
    }, SAFETY_POLL_MS)

    const handleFocus = () => {
      void loadTree(false)
    }
    window.addEventListener('focus', handleFocus)

    return () => {
      unsubscribe()
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
    }
  }, [loadTree])

  const handleFileClick = useCallback((path: string, relativePath: string) => {
    setSelectedFile(relativePath)
    // Store the selected file for preview
    useAppStore.getState().setSelectedFile(relativePath, path)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="animate-spin text-neutral-500" />
      </div>
    )
  }

  if (!tree) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-neutral-500">
        <FolderOpen size={24} className="mb-2 text-neutral-600" />
        <p className="text-xs">No workspace open</p>
        <p className="mt-1 text-[11px] text-neutral-600">
          Switch to a project folder from the workspace switcher in the sidebar.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Branch indicator */}
      {gitBranch && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-neutral-500 border-b border-neutral-800">
          <GitBranch size={12} />
          <span>{gitBranch}</span>
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {tree.children?.map((child) => (
          <TreeNodeComponent
            key={child.relativePath}
            node={child}
            gitStatus={gitStatus}
            selectedFile={selectedFile}
            onFileClick={handleFileClick}
            depth={0}
          />
        ))}
      </div>
    </div>
  )
}

function TreeNodeComponent({
  node,
  gitStatus,
  selectedFile,
  onFileClick,
  depth,
}: {
  node: FileTreeNode
  gitStatus: Record<string, GitFileStatus>
  selectedFile: string | null
  onFileClick: (path: string, relativePath: string) => void
  depth: number
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(depth < 1)
  const status = gitStatus[node.relativePath]
  const isSelected = selectedFile === node.relativePath

  if (node.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1 py-0.5 px-2 text-xs text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-300 transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? (
            <FolderOpen size={12} className="text-blue-400 shrink-0" />
          ) : (
            <FolderClosed size={12} className="text-neutral-500 shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children?.map((child) => (
          <TreeNodeComponent
            key={child.relativePath}
            node={child}
            gitStatus={gitStatus}
            selectedFile={selectedFile}
            onFileClick={onFileClick}
            depth={depth + 1}
          />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => onFileClick(node.path, node.relativePath)}
      className={clsx(
        'flex w-full items-center gap-1.5 py-0.5 px-2 text-xs transition-colors',
        isSelected
          ? 'bg-blue-900/30 text-blue-300'
          : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-300'
      )}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
    >
      <File size={12} className="shrink-0 text-neutral-500" />
      <span className="truncate">{node.name}</span>
      {status && <GitStatusBadge status={status} />}
    </button>
  )
}

function GitStatusBadge({ status }: { status: GitFileStatus }): React.JSX.Element {
  const label = status.isStaged ? status.index : status.worktree
  if (label === ' ' || label === '?') {
    if (label === '?') {
      return (
        <span className="ml-auto rounded px-1 py-0.5 text-[9px] bg-green-900/30 text-green-400">
          U
        </span>
      )
    }
    return <></>
  }

  const colorMap: Record<string, string> = {
    M: 'bg-yellow-900/30 text-yellow-400',
    A: 'bg-green-900/30 text-green-400',
    D: 'bg-red-900/30 text-red-400',
    R: 'bg-purple-900/30 text-purple-400',
    C: 'bg-blue-900/30 text-blue-400',
  }

  return (
    <span className={clsx('ml-auto rounded px-1 py-0.5 text-[9px]', colorMap[label] ?? 'bg-neutral-800 text-neutral-500')}>
      {label}
    </span>
  )
}

// ─── File Search ─────────────────────────────────────────────────────────────

interface FileSearchProps {
  isOpen: boolean
  onClose: () => void
}

export function FileSearch({ isOpen, onClose }: FileSearchProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [contentMode, setContentMode] = useState(false)

  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setResults([])
    }
  }, [isOpen])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }

    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const searchResults = contentMode
          ? await window.piDesktop.files.searchContent(query)
          : await window.piDesktop.files.search(query)
        setResults(searchResults)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 200)

    return () => clearTimeout(timer)
  }, [query, contentMode])

  const handleSelect = (result: FileSearchResult) => {
    useAppStore.getState().setSelectedFile(result.relativePath, result.path)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center border-b border-neutral-800 px-4 py-3">
          <Search size={16} className="text-neutral-500 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={contentMode ? 'Search file contents...' : 'Search files by name...'}
            className="flex-1 ml-3 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 outline-none"
            autoFocus
          />
          <button
            onClick={() => setContentMode(!contentMode)}
            className={clsx(
              'rounded px-2 py-0.5 text-[10px] transition-colors',
              contentMode
                ? 'bg-blue-900/30 text-blue-400'
                : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'
            )}
          >
            {contentMode ? 'CONTENT' : 'FILES'}
          </button>
          <button
            onClick={onClose}
            className="ml-2 rounded p-1 text-neutral-500 hover:text-neutral-300"
          >
            <X size={14} />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-neutral-500" />
            </div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-xs text-neutral-600">
              {query.trim() ? 'No results found' : 'Type to search...'}
            </div>
          ) : (
            <div className="py-1">
              {results.map((result, i) => (
                <button
                  key={`${result.path}-${i}`}
                  onClick={() => handleSelect(result)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-neutral-800 transition-colors"
                >
                  <FileText size={14} className="shrink-0 text-neutral-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-neutral-200 truncate">
                      {result.relativePath}
                    </div>
                    {result.matchType === 'content' && result.snippet && (
                      <div className="text-xs text-neutral-500 truncate mt-0.5">
                        Line {result.line}: {result.snippet}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-800 px-4 py-2 flex items-center justify-between text-xs text-neutral-600">
          <span>{results.length} results</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  )
}

// ─── File Preview ────────────────────────────────────────────────────────────

export function FilePreview(): React.JSX.Element | null {
  const selectedFile = useAppStore((state) => state.selectedFile)
  const [content, setContent] = useState<string | null>(null)
  const [savedContent, setSavedContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDirty = content !== null && savedContent !== null && content !== savedContent

  useEffect(() => {
    if (!selectedFile) {
      setContent(null)
      setSavedContent(null)
      return
    }

    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await window.piDesktop.files.read(selectedFile.path)
        if (!cancelled) {
          setContent(data)
          setSavedContent(data)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to read file')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [selectedFile])

  // Cleanup pending debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleChange = useCallback((value: string) => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setContent(value)
      debounceRef.current = null
    }, 150)
  }, [])

  if (!selectedFile) return null

  const handleSave = async () => {
    if (content === null || !selectedFile) return

    setSaving(true)
    setError(null)
    setSaveSuccess(false)
    try {
      await window.piDesktop.files.write(selectedFile.path, content)
      setSavedContent(content)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save file')
    } finally {
      setSaving(false)
    }
  }

  const handleRevert = () => {
    if (savedContent !== null) {
      setContent(savedContent)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="shrink-0 text-neutral-500" />
          <span className="text-xs text-neutral-300 truncate">{selectedFile.relativePath}</span>
          {saveSuccess ? (
            <span className="rounded bg-green-900/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-400">
              saved
            </span>
          ) : isDirty ? (
            <span className="rounded bg-yellow-900/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-yellow-400">
              modified
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRevert}
            disabled={!isDirty || saving}
            className="rounded p-1 text-neutral-500 transition-colors hover:text-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
            title="Revert changes"
          >
            <RotateCcw size={12} />
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="rounded p-1 text-neutral-500 transition-colors hover:text-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
            title="Save file"
          >
            <Save size={12} />
          </button>
          <button
            onClick={() => useAppStore.getState().setSelectedFile(null, null)}
            className="rounded p-1 text-neutral-500 hover:text-neutral-300"
            title="Close editor"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-neutral-500" />
          </div>
        ) : error ? (
          <div className="p-4 text-xs text-red-400">{error}</div>
        ) : content !== null ? (
          <CodeEditor
            filePath={selectedFile.relativePath}
            value={content}
            readOnly={false}
            onChange={handleChange}
          />
        ) : null}
      </div>
    </div>
  )
}
