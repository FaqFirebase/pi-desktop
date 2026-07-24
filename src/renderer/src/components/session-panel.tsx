import { useAppStore } from '../store'
import { getSessionTitle } from '../utils/session-title'
import { FolderOpen, Plus, Clock, Search, ChevronRight, ChevronDown, FolderTree, Tag, X, MoreVertical, Archive, ArchiveRestore, Trash2, Sparkles } from 'lucide-react'
import { useState, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import type { SessionListItem } from '../../../shared/ipc-contracts'
import { useContextMenu, buildSessionContextMenu } from './context-menu'
import { getSessionMenuPosition, type MenuPosition } from './session-menu-position'

export function SessionPanel(): React.JSX.Element {
  const sessionList = useAppStore((state) => state.sessionList)
  const sessionState = useAppStore((state) => state.sessionState)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const switchSession = useAppStore((state) => state.switchSession)
  const switchWorkspace = useAppStore((state) => state.switchWorkspace)
  const createNewSession = useAppStore((state) => state.createNewSession)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const refreshSessionList = useAppStore((state) => state.refreshSessionList)
  const workspaces = useAppStore((state) => state.workspaces)
  const archivedSessions = useAppStore((state) => state.archivedSessions)
  const showArchived = useAppStore((state) => state.showArchived)
  const toggleShowArchived = useAppStore((state) => state.toggleShowArchived)
  const ensureAutoTags = useAppStore((state) => state.ensureAutoTags)
  const settings = useAppStore((state) => state.settings)
  const toggleSessionGroupCollapsed = useAppStore((state) => state.toggleSessionGroupCollapsed)

  // Auto-assign a context tag to any session the user hasn't tagged. The main
  // process skips already-processed sessions, so this is idempotent and only
  // reads session files the first time each session is seen.
  useEffect(() => {
    if (sessionList.length === 0) return
    void ensureAutoTags(
      sessionList.map((s) => ({ sessionId: s.sessionId, path: s.path }))
    )
  }, [sessionList, ensureAutoTags])

  const [searchQuery, setSearchQuery] = useState('')
  const [showAllProjects, setShowAllProjects] = useState(true)

  // Collapsed project groups are persisted in settings so the layout survives
  // navigating away and app restarts.
  const collapsedGroups = useMemo(
    () => new Set(settings?.collapsedSessionGroups ?? []),
    [settings?.collapsedSessionGroups]
  )

  const archivedCount = useMemo(() => {
    return sessionList.filter((s) => s.sessionId in archivedSessions).length
  }, [sessionList, archivedSessions])

  // Group sessions by project (after filtering by archive state)
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, SessionListItem[]>()

    for (const session of sessionList) {
      const isArchived = session.sessionId in archivedSessions
      if (isArchived && !showArchived) continue

      const key = session.projectPath || 'unknown'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(session)
    }

    // Sort groups by most recent session
    const sorted = Array.from(groups.entries()).sort((a, b) => {
      const aLatest = Math.max(...a[1].map((s) => s.lastModified))
      const bLatest = Math.max(...b[1].map((s) => s.lastModified))
      return bLatest - aLatest
    })

    return sorted
  }, [sessionList, archivedSessions, showArchived])

  // Filter by search
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupedSessions

    const q = searchQuery.toLowerCase()
    return groupedSessions
      .map(([project, sessions]) => [
        project,
        sessions.filter(
          (s) =>
            s.name?.toLowerCase().includes(q) ||
            s.sessionId.toLowerCase().includes(q) ||
            s.projectName.toLowerCase().includes(q) ||
            s.projectPath.toLowerCase().includes(q)
        ),
      ])
      .filter(([_, sessions]) => (sessions as SessionListItem[]).length > 0) as [string, SessionListItem[]][]
  }, [groupedSessions, searchQuery])

  const handleSwitchSession = async (session: SessionListItem) => {
    // If session belongs to a different workspace, switch workspace first
    if (session.projectPath && session.projectPath !== activeWorkspace?.path) {
      const matchingWorkspace = workspaces.find((w) => w.path === session.projectPath)
      if (matchingWorkspace) {
        await switchWorkspace(matchingWorkspace.id)
      } else {
        // Auto-create workspace for this project
        await useAppStore.getState().createWorkspace(session.projectName, session.projectPath)
        const updatedWorkspaces = useAppStore.getState().workspaces
        const newWorkspace = updatedWorkspaces.find((w) => w.path === session.projectPath)
        if (newWorkspace) {
          await switchWorkspace(newWorkspace.id)
        }
      }
    }

    await switchSession(session.path)
    setCurrentView('chat')
  }

  const toggleProject = (project: string) => {
    void toggleSessionGroupCollapsed(project)
  }

  const totalSessions = sessionList.length
  const totalProjects = groupedSessions.length

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FolderOpen size={20} className="text-muted" />
            <h1 className="text-lg font-semibold text-primary">Sessions</h1>
            <span className="rounded-full bg-card px-2 py-0.5 text-xs text-dim">
              {totalSessions} sessions · {totalProjects} projects
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={refreshSessionList}
              className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-primary transition-colors"
            >
              Refresh
            </button>
            <button
              onClick={createNewSession}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover transition-colors"
            >
              <Plus size={14} />
              New Session
            </button>
          </div>
        </div>

        {/* Filter controls */}
        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
            <input
              type="text"
              placeholder="Search sessions or projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface py-2 pl-9 pr-4 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none"
            />
          </div>
          <button
            onClick={() => setShowAllProjects(!showAllProjects)}
            className={clsx(
              'rounded-md px-3 py-2 text-xs transition-colors',
              showAllProjects
                ? 'bg-accent-bg text-accent-fg'
                : 'bg-card text-muted hover:text-secondary'
            )}
          >
            {showAllProjects ? 'All Projects' : 'Current Only'}
          </button>
          <button
            onClick={toggleShowArchived}
            title={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-3 py-2 text-xs transition-colors',
              showArchived
                ? 'bg-warning-bg text-warning'
                : 'bg-card text-muted hover:text-secondary'
            )}
          >
            <Archive size={12} />
            {showArchived ? 'Hiding none' : `Archived (${archivedCount})`}
          </button>
        </div>

        {/* Current workspace indicator */}
        {activeWorkspace && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-surface border border-border px-4 py-2">
            <FolderTree size={14} className="text-dim" />
            <span className="text-xs text-muted">Current workspace:</span>
            <span className="text-sm text-primary font-medium">{activeWorkspace.name}</span>
            <span className="text-xs text-dim truncate">{activeWorkspace.path}</span>
          </div>
        )}

        {/* Sessions grouped by project */}
        {filteredGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-dim">
            <FolderOpen size={32} className="mb-3 text-faint" />
            <p className="text-sm">
              {searchQuery ? 'No sessions match your search' : 'No sessions yet'}
            </p>
            {!searchQuery && (
              <button
                onClick={createNewSession}
                className="mt-3 text-sm text-accent-fg/80 hover:text-accent-fg"
              >
                Create your first session
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredGroups.map(([projectPath, sessions]) => {
              // Default expanded; collapse only when the user has collapsed this
              // group. An active search force-expands so matches stay visible.
              const isExpanded = searchQuery.trim() !== '' || !collapsedGroups.has(projectPath)
              const isCurrentProject = projectPath === activeWorkspace?.path
              const projectName = sessions[0]?.projectName ?? 'Unknown'
              const latestSession = sessions[0]

              return (
                <div
                  key={projectPath}
                  className={clsx(
                    'rounded-lg border overflow-hidden',
                    isCurrentProject
                      ? 'border-accent-bg bg-accent-bg'
                      : 'border-border bg-surface/30'
                  )}
                >
                  {/* Project header */}
                  <button
                    onClick={() => toggleProject(projectPath)}
                    className="flex w-full items-center gap-2 px-4 py-2.5 hover:bg-surface-hover/30 transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} className="text-dim shrink-0" />
                    ) : (
                      <ChevronRight size={14} className="text-dim shrink-0" />
                    )}
                    <FolderTree
                      size={14}
                      className={clsx(
                        'shrink-0',
                        isCurrentProject ? 'text-accent-fg' : 'text-dim'
                      )}
                    />
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-primary">
                          {projectName}
                        </span>
                        {isCurrentProject && (
                          <span className="rounded bg-accent-bg px-1.5 py-0.5 text-[10px] text-accent-fg">
                            current
                          </span>
                        )}
                        <span className="text-xs text-faint">
                          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="text-[11px] text-faint truncate">
                        {projectPath}
                      </div>
                    </div>
                    <div className="text-[10px] text-faint shrink-0">
                      {formatRelativeTime(latestSession.lastModified)}
                    </div>
                  </button>

                  {/* Sessions in this project */}
                  {isExpanded && (
                    <div className="border-t border-border/50">
                      {sessions.map((session) => (
                        <SessionEntry
                          key={session.path}
                          session={session}
                          isActive={sessionState?.sessionFile === session.path}
                          onSelect={() => handleSwitchSession(session)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`

  return new Date(timestamp).toLocaleDateString()
}

// ─── Session Entry with Tags ─────────────────────────────────────────────────

function SessionEntry({
  session,
  isActive,
  onSelect,
}: {
  session: SessionListItem
  isActive: boolean
  onSelect: () => void
}): React.JSX.Element {
  const sessionTags = useAppStore((state) => state.sessionTags)
  const autoTags = useAppStore((state) => state.autoTags)
  const addSessionTag = useAppStore((state) => state.addSessionTag)
  const removeSessionTag = useAppStore((state) => state.removeSessionTag)
  const removeAutoTag = useAppStore((state) => state.removeAutoTag)
  const archivedSessions = useAppStore((state) => state.archivedSessions)
  const archiveSession = useAppStore((state) => state.archiveSession)
  const unarchiveSession = useAppStore((state) => state.unarchiveSession)
  const deleteSession = useAppStore((state) => state.deleteSession)

  const tags = sessionTags[session.sessionId] ?? []
  const autoTag = autoTags[session.sessionId]
  const isArchived = session.sessionId in archivedSessions
  const [showTagInput, setShowTagInput] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuPopupRef = useRef<HTMLDivElement>(null)

  // Close kebab menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        !menuButtonRef.current?.contains(target) &&
        !menuPopupRef.current?.contains(target)
      ) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = () => setMenuOpen(false)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [menuOpen])

  const toggleMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()

    if (menuOpen) {
      setMenuOpen(false)
      return
    }

    const rect = e.currentTarget.getBoundingClientRect()
    setMenuPosition(getSessionMenuPosition({
      triggerRect: rect,
      menuWidth: 150,
      menuHeight: 74,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }))
    setMenuOpen(true)
  }

  const handleAddTag = async () => {
    if (tagInput.trim()) {
      await addSessionTag(session.sessionId, tagInput.trim())
      setTagInput('')
      setShowTagInput(false)
    }
  }

  const handleArchive = async () => {
    setMenuOpen(false)
    setBusy(true)
    try {
      if (isArchived) await unarchiveSession(session.sessionId)
      else await archiveSession(session.sessionId)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    setBusy(true)
    try {
      await deleteSession(session)
    } finally {
      setBusy(false)
      setConfirmingDelete(false)
    }
  }

  const { show: showCtx, ContextMenuComponent: RowMenu } = useContextMenu()
  const handleRightClick = (e: React.MouseEvent): void => {
    // Stop the document-level default menu from also firing
    e.nativeEvent.stopPropagation()
    showCtx(
      e,
      buildSessionContextMenu(session, isArchived, {
        onOpen: () => onSelect(),
        onArchive: (id) => { archiveSession(id) },
        onUnarchive: (id) => { unarchiveSession(id) },
        // Use the inline confirmation row in this surface (UX matches the
        // existing flow) instead of a window.confirm.
        onDelete: () => setConfirmingDelete(true),
      })
    )
  }

  return (
    <div
      onContextMenu={handleRightClick}
      className={clsx(
        'group py-2 pl-10 pr-10 transition-colors relative',
        isActive
          ? 'bg-accent-bg'
          : isArchived
            ? 'bg-surface/40 opacity-60 hover:opacity-100 hover:bg-surface-hover/30'
            : 'hover:bg-surface-hover/30',
        busy && 'pointer-events-none opacity-40'
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
        className="flex w-full cursor-pointer items-center gap-3 text-left"
      >
        <Clock size={12} className="shrink-0 text-faint" />
        <div className="min-w-0 flex-1">
          <div className={clsx('text-sm truncate', isActive ? 'text-accent-fg' : 'text-muted')}>
            {getSessionTitle(session.name, session.sessionId)}
          </div>
          {(tags.length > 0 || autoTag) && (
            <div className="flex flex-wrap gap-1 mt-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 rounded bg-card px-1.5 py-0.5 text-[10px] text-muted"
                >
                  <Tag size={8} />
                  {tag}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeSessionTag(session.sessionId, tag)
                    }}
                    title={`Remove tag ${tag}`}
                    aria-label={`Remove tag ${tag}`}
                    className="ml-0.5 hover:text-primary"
                  >
                    <X size={8} />
                  </button>
                </span>
              ))}
              {autoTag && (
                <span
                  title="Auto-tagged from chat context — add your own tag to replace it"
                  className="inline-flex items-center gap-0.5 rounded border border-dashed border-border-strong px-1.5 py-0.5 text-[10px] text-dim"
                >
                  <Sparkles size={8} />
                  {autoTag}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeAutoTag(session.sessionId)
                    }}
                    title={`Remove auto-tag ${autoTag}`}
                    aria-label={`Remove auto-tag ${autoTag}`}
                    className="ml-0.5 hover:text-secondary"
                  >
                    <X size={8} />
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="text-[10px] text-faint shrink-0">
          {formatRelativeTime(session.lastModified)}
        </div>
        {isArchived && (
          <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] text-warning">
            archived
          </span>
        )}
        {isActive && (
          <span className="rounded bg-accent-bg px-1.5 py-0.5 text-[10px] text-accent-fg">
            active
          </span>
        )}
      </div>

      {/* Kebab menu trigger — always visible so the actions are discoverable.
          The row also honors right-click for the same actions (see onContextMenu
          on the wrapping div). */}
      <div className="absolute right-2 top-1.5 transition-opacity">
        <button
          ref={menuButtonRef}
          onClick={toggleMenu}
          className="rounded p-1 text-muted hover:bg-elevated/60 hover:text-primary"
          aria-label="Session actions"
          aria-expanded={menuOpen}
          title="Session actions (or right-click the row)"
        >
          <MoreVertical size={14} />
        </button>
      </div>
      {menuOpen && menuPosition && createPortal(
        <div
          ref={menuPopupRef}
          className="fixed z-[9999] min-w-[150px] rounded-md border border-border-strong bg-surface py-1 text-sm shadow-xl shadow-black/40"
          style={{ left: menuPosition.x, top: menuPosition.y }}
        >
          <button
            onClick={handleArchive}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-secondary hover:bg-surface-hover"
          >
            {isArchived ? <><ArchiveRestore size={13} /> Unarchive</> : <><Archive size={13} /> Archive</>}
          </button>
          <button
            onClick={() => {
              setMenuOpen(false)
              setConfirmingDelete(true)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-error hover:bg-error-bg"
          >
            <Trash2 size={13} /> Delete...
          </button>
        </div>,
        document.body
      )}

      {/* Inline delete confirmation */}
      {confirmingDelete && (
        <div className="mt-2 flex items-center gap-2 rounded border border-error-bg bg-error-bg px-2 py-1.5 text-[11px] text-error">
          <Trash2 size={12} className="shrink-0" />
          <span className="flex-1">
            Delete this session? Will use <code className="text-error">trash</code> if available, otherwise permanent.
          </span>
          <button
            onClick={() => setConfirmingDelete(false)}
            className="rounded px-2 py-0.5 text-muted hover:text-primary"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            className="rounded bg-error px-2 py-0.5 text-white hover:bg-error-hover"
          >
            Delete
          </button>
        </div>
      )}

      {/* Tag input (shown on hover, hidden during delete confirm) */}
      {!confirmingDelete && (
        <div className="mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {showTagInput ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddTag()
                  if (e.key === 'Escape') setShowTagInput(false)
                }}
                placeholder="Add tag..."
                className="flex-1 rounded border border-border-strong bg-card px-2 py-0.5 text-[10px] text-secondary placeholder:text-faint focus:border-focus focus:outline-none"
                autoFocus
              />
              <button
                onClick={handleAddTag}
                className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-white"
              >
                Add
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowTagInput(true)}
              className="flex items-center gap-1 text-[10px] text-faint hover:text-muted"
            >
              <Tag size={10} />
              Add tag
            </button>
          )}
        </div>
      )}
      {RowMenu}
    </div>
  )
}
