import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../store'
import type { FileTreeNode, GitFileStatus, FileSearchResult } from '../../../shared/ipc-contracts'
import { CodeEditor } from './code-editor'
import { MarkdownRenderer } from './markdown-renderer'
import { isImagePath } from './chat-file-link'
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
  Eye,
  Code2,
  ShieldAlert,
} from 'lucide-react'

// `<webview>` (enabled via webviewTag) isn't a typed JSX intrinsic; cast the tag
// to a component so TS accepts the props we use. It renders the HTML preview in
// an isolated guest process so its JavaScript runs without touching the app CSP.
const Webview = 'webview' as unknown as React.FC<
  React.HTMLAttributes<HTMLElement> & { src: string; partition?: string; plugins?: boolean }
>

function toFileUrl(absolutePath: string): string {
  let p = absolutePath.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = '/' + p // Windows "C:/…" -> "/C:/…"
  return encodeURI('file://' + p)
}

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
  const [pathExists, setPathExists] = useState(true)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)

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
      setPathExists(true)
    } catch {
      // The tree couldn't load — usually the workspace folder is missing or
      // unreadable. Record whether it exists so the UI can say which.
      setTree(null)
      try {
        setPathExists(await window.piDesktop.workspace.pathExists())
      } catch {
        setPathExists(true)
      }
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
    // Store the selected file for preview (images route to the image viewer).
    const name = relativePath.split(/[\\/]/).pop() ?? relativePath
    useAppStore.getState().setPreviewTarget({
      kind: isImagePath(name) ? 'image' : 'code',
      name,
      path,
      relativePath,
    })
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="animate-spin text-dim" />
      </div>
    )
  }

  if (!tree) {
    // Active workspace whose folder is missing/unreadable — say so explicitly
    // (e.g. the folder was moved/deleted or the saved path is wrong).
    if (activeWorkspace && !pathExists) {
      return (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-dim">
          <FolderOpen size={24} className="mb-2 text-warning/70" />
          <p className="text-xs text-warning">Folder not found</p>
          <p className="mt-1 break-all text-[11px] text-dim">{activeWorkspace.path}</p>
          <p className="mt-2 text-[11px] text-faint">
            The folder may have moved or been deleted. Right-click the workspace in the
            sidebar and choose “Change folder…” to point it somewhere else.
          </p>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-dim">
        <FolderOpen size={24} className="mb-2 text-faint" />
        <p className="text-xs">No workspace open</p>
        <p className="mt-1 text-[11px] text-faint">
          Switch to a project folder from the workspace switcher in the sidebar.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Branch indicator */}
      {gitBranch && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-dim border-b border-border">
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
          className="flex w-full items-center gap-1 py-0.5 px-2 text-sm text-muted hover:bg-surface-hover/50 hover:text-secondary transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? (
            <FolderOpen size={12} className="text-accent-fg shrink-0" />
          ) : (
            <FolderClosed size={12} className="text-dim shrink-0" />
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
        'flex w-full items-center gap-1.5 py-0.5 px-2 text-sm transition-colors',
        isSelected
          ? 'bg-accent-bg text-accent-fg'
          : 'text-muted hover:bg-surface-hover/50 hover:text-secondary'
      )}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
    >
      <File size={12} className="shrink-0 text-dim" />
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
        <span className="ml-auto rounded px-1 py-0.5 text-[9px] bg-success-bg text-success">
          U
        </span>
      )
    }
    return <></>
  }

  const colorMap: Record<string, string> = {
    M: 'bg-warning-bg text-warning',
    A: 'bg-success-bg text-success',
    D: 'bg-error-bg text-error',
    R: 'bg-special-bg text-special',
    C: 'bg-accent-bg text-accent-fg',
  }

  return (
    <span className={clsx('ml-auto rounded px-1 py-0.5 text-[9px]', colorMap[label] ?? 'bg-card text-dim')}>
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

  // Close on Escape. Capture phase + stopPropagation so it preempts the
  // window-level Escape-to-abort handler while the modal is open.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isOpen, onClose])

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
    useAppStore.getState().setPreviewTarget({
      kind: isImagePath(result.name) ? 'image' : 'code',
      name: result.name,
      path: result.path,
      relativePath: result.relativePath,
    })
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg rounded-xl border border-border-strong bg-surface shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center border-b border-border px-4 py-3">
          <Search size={16} className="text-dim shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={contentMode ? 'Search file contents...' : 'Search files by name...'}
            className="flex-1 ml-3 bg-transparent text-sm text-primary placeholder:text-faint outline-none"
            autoFocus
          />
          <button
            onClick={() => setContentMode(!contentMode)}
            className={clsx(
              'rounded px-2 py-0.5 text-[10px] transition-colors',
              contentMode
                ? 'bg-accent-bg text-accent-fg'
                : 'bg-card text-dim hover:text-secondary'
            )}
          >
            {contentMode ? 'CONTENT' : 'FILES'}
          </button>
          <button
            onClick={onClose}
            className="ml-2 rounded p-1 text-dim hover:text-secondary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-dim" />
            </div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-xs text-faint">
              {query.trim() ? 'No results found' : 'Type to search...'}
            </div>
          ) : (
            <div className="py-1">
              {results.map((result, i) => (
                <button
                  key={`${result.path}-${i}`}
                  onClick={() => handleSelect(result)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-hover transition-colors"
                >
                  <FileText size={14} className="shrink-0 text-dim" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-primary truncate">
                      {result.relativePath}
                    </div>
                    {result.matchType === 'content' && result.snippet && (
                      <div className="text-xs text-dim truncate mt-0.5">
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
        <div className="border-t border-border px-4 py-2 flex items-center justify-between text-xs text-faint">
          <span>{results.length} results</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  )
}

// ─── File Preview ────────────────────────────────────────────────────────────

export function FilePreview(): React.JSX.Element | null {
  const target = useAppStore((state) => state.previewTarget)
  const file = target?.kind === 'code' ? target : null
  const [content, setContent] = useState<string | null>(null)
  const [savedContent, setSavedContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('preview')
  // Bumped after a save so the HTML <webview> remounts and reloads from disk.
  const [reloadKey, setReloadKey] = useState(0)
  // null until resolved; false means the HTML preview runs without scripts.
  const [workspaceTrusted, setWorkspaceTrusted] = useState<boolean | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDirty = content !== null && savedContent !== null && content !== savedContent

  const displayPath = file?.relativePath ?? file?.name ?? ''
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(displayPath)
  const isHtml = /\.(html?|htm)$/i.test(displayPath)
  // PDFs render in Chromium's built-in viewer via the <webview> — binary, so we
  // never read them as text or offer editing.
  const isPdf = /\.pdf$/i.test(displayPath)
  const canPreview = isMarkdown || isHtml
  const path = file?.path ?? null

  useEffect(() => {
    if (!path || isPdf) {
      setContent(null)
      setSavedContent(null)
      return
    }

    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await window.piDesktop.files.read(path)
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
  }, [path, isPdf])

  // Default to the rendered preview for markdown/HTML, source otherwise.
  useEffect(() => {
    setViewMode(canPreview ? 'preview' : 'source')
  }, [path, canPreview])

  // The HTML preview runs scripts only for a trusted workspace; fetch that state
  // so we can offer to trust it when scripts are disabled.
  useEffect(() => {
    if (!isHtml) {
      setWorkspaceTrusted(null)
      return
    }
    let cancelled = false
    void window.piDesktop.permissionRules.workspaceStatus().then((status) => {
      if (!cancelled) setWorkspaceTrusted(status.trusted)
    })
    return () => {
      cancelled = true
    }
  }, [isHtml, path])

  const handleTrustWorkspace = useCallback(async () => {
    const status = await window.piDesktop.permissionRules.setWorkspaceTrust(true)
    setWorkspaceTrusted(status.trusted)
    // Remount the <webview> so it re-attaches with scripts enabled.
    setReloadKey((k) => k + 1)
  }, [])

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

  if (!file || !path) return null

  const handleSave = async () => {
    if (content === null) return

    setSaving(true)
    setError(null)
    setSaveSuccess(false)
    try {
      await window.piDesktop.files.write(path, content)
      setSavedContent(content)
      setSaveSuccess(true)
      setReloadKey((k) => k + 1)
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
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--color-app)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="shrink-0 text-dim" />
          <span className="text-xs text-secondary truncate">{displayPath}</span>
          {saveSuccess ? (
            <span className="rounded bg-success-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success">
              saved
            </span>
          ) : isDirty ? (
            <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning">
              modified
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {canPreview && (
            <div className="mr-1 flex items-center rounded bg-surface p-0.5">
              <button
                onClick={() => setViewMode('source')}
                className={clsx(
                  'rounded p-1 transition-colors',
                  viewMode === 'source' ? 'bg-elevated text-primary' : 'text-dim hover:text-secondary'
                )}
                title="Source"
              >
                <Code2 size={12} />
              </button>
              <button
                onClick={() => setViewMode('preview')}
                className={clsx(
                  'rounded p-1 transition-colors',
                  viewMode === 'preview' ? 'bg-elevated text-primary' : 'text-dim hover:text-secondary'
                )}
                title="Preview"
              >
                <Eye size={12} />
              </button>
            </div>
          )}
          {!isPdf && (
            <>
              <button
                onClick={handleRevert}
                disabled={!isDirty || saving}
                className="rounded p-1 text-dim transition-colors hover:text-secondary disabled:cursor-not-allowed disabled:opacity-40"
                title="Revert changes"
              >
                <RotateCcw size={12} />
              </button>
              <button
                onClick={handleSave}
                disabled={!isDirty || saving}
                className="rounded p-1 text-dim transition-colors hover:text-secondary disabled:cursor-not-allowed disabled:opacity-40"
                title="Save file"
              >
                <Save size={12} />
              </button>
            </>
          )}
          <button
            onClick={() => useAppStore.getState().setPreviewTarget(null)}
            className="rounded p-1 text-dim hover:text-secondary"
            title="Close editor"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-auto">
        {isPdf ? (
          <Webview
            // Ask Chromium's PDF viewer to open with both the thumbnail/bookmark
            // sidebar and the top toolbar hidden, for a clean embedded preview.
            src={`${toFileUrl(path)}#toolbar=0&navpanes=0`}
            partition="persist:pdf-preview"
            plugins
            className="flex-1"
            style={{ display: 'flex', width: '100%', height: '100%', border: 'none' }}
          />
        ) : loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-dim" />
          </div>
        ) : error ? (
          <div className="p-4 text-xs text-error">{error}</div>
        ) : content === null ? null : viewMode === 'preview' && isMarkdown ? (
          <div className="markdown-body text-sm p-4">
            <MarkdownRenderer content={content} />
          </div>
        ) : viewMode === 'preview' && isHtml ? (
          <div className="flex flex-1 flex-col">
            {workspaceTrusted === false && (
              <div className="flex items-center justify-between gap-2 border-b border-warning-bg bg-warning-bg px-3 py-1.5 text-xs text-warning">
                <span className="flex items-center gap-1.5">
                  <ShieldAlert size={13} className="shrink-0" />
                  Scripts are disabled for this untrusted workspace&apos;s preview.
                </span>
                <button
                  type="button"
                  onClick={() => void handleTrustWorkspace()}
                  className="shrink-0 rounded-md border border-border-strong bg-surface px-2 py-1 text-primary transition-colors hover:border-border-strong-hover"
                >
                  Trust workspace
                </button>
              </div>
            )}
            <Webview
              key={reloadKey}
              src={toFileUrl(path)}
              partition="preview"
              className="flex-1"
              style={{ display: 'flex', width: '100%', height: '100%', border: 'none' }}
            />
          </div>
        ) : (
          <CodeEditor
            filePath={displayPath}
            value={content}
            readOnly={false}
            onChange={handleChange}
          />
        )}
      </div>
    </div>
  )
}
