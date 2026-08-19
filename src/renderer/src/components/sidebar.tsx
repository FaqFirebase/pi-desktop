import { useAppStore, countPromptsWaitingElsewhere, formatPromptsWaiting } from '../store'
import { summarizeBackgroundActivity, workspaceActivityIndicator } from './sidebar-activity'
import { pathGroupKey, pathsEqual } from '../../../shared/path-compare'
import { clsx } from 'clsx'
import {
  Home,
  MessageSquare,
  Settings,
  FolderOpen,
  Plus,
  PanelLeftClose,
  Clock,
  Activity,
  LayoutDashboard,
  Package,
  Layers,
  ChevronDown,
  Check,
  Trash2,
  StickyNote,
  Archive,
  Sparkles,
  Stethoscope,
  Pencil,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { useMemo, useState, useRef } from 'react'
import { StatusPopover } from './status-popover'
import { useContextMenu, buildSessionContextMenu } from './context-menu'
import { getSessionRowLabels } from './sidebar-session-labels'
import { ResizeHandle } from './resize-handle'
import { getSessionTitle } from '../utils/session-title'
import { formatRelativeTime } from '../utils/format-relative-time'
import { SessionRuntimeIndicator } from './session-runtime-indicator'
import { resolveRunSessionId } from '../utils/workflow-runs'
import { clampSidebarWidth, resolveSidebarWidth } from '../../../shared/sidebar-width'
import type { SessionListItem } from '../../../shared/ipc-contracts'

/** Cap how many workspace groups appear in the Recent list. */
const MAX_RECENT_GROUPS = 12
/** Cap sessions shown inside an expanded workspace group. */
const MAX_SESSIONS_PER_GROUP = 12

interface RecentSessionGroup {
  projectPath: string
  projectName: string
  sessions: SessionListItem[]
  latest: SessionListItem
}

export function Sidebar(): React.JSX.Element {
  const currentView = useAppStore((state) => state.currentView)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const sessionState = useAppStore((state) => state.sessionState)
  const sessionList = useAppStore((state) => state.sessionList)
  const sessionRuntimes = useAppStore((state) => state.sessionRuntimes)
  const activeSessionRuntimeId = useAppStore((state) => state.activeSessionRuntimeId)
  const createNewSession = useAppStore((state) => state.createNewSession)
  const setTaskLauncherOpen = useAppStore((state) => state.setTaskLauncherOpen)
  const openFolderAsWorkspace = useAppStore((state) => state.openFolderAsWorkspace)
  const openWorkflowRunsForSession = useAppStore((state) => state.openWorkflowRunsForSession)
  const openWorkflowRunsForWorkspace = useAppStore((state) => state.openWorkflowRunsForWorkspace)
  const setWorkflowPanelOpen = useAppStore((state) => state.setWorkflowPanelOpen)
  const workflowPanelOpen = useAppStore((state) => state.workflowPanelOpen)
  const workflowPanelWorkspaceId = useAppStore((state) => state.workflowPanelWorkspaceId)
  const workflowPanelFilter = useAppStore((state) => state.workflowPanelFilter)
  const setSessionsScope = useAppStore((state) => state.setSessionsScope)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const archivedSessions = useAppStore((state) => state.archivedSessions)
  const archiveSession = useAppStore((state) => state.archiveSession)
  const unarchiveSession = useAppStore((state) => state.unarchiveSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const setSessionName = useAppStore((state) => state.setSessionName)
  const persistedWidth = useAppStore((state) => state.settings?.sidebarWidth)
  const saveSidebarWidth = useAppStore((state) => state.saveSidebarWidth)

  const { show: showMenu, ContextMenuComponent: SessionMenu } = useContextMenu()

  const [archivedOpen, setArchivedOpen] = useState(false)

  // The live width during a drag. Kept local so dragging never writes
  // settings.json; the draft outlives the drag so the row does not jump while the
  // save round-trips, and a remount falls back to the saved value.
  const [widthDraft, setWidthDraft] = useState<number | null>(null)
  const sidebarWidth = resolveSidebarWidth(widthDraft, persistedWidth)
  const savedWidth = resolveSidebarWidth(null, persistedWidth)
  // The handle registers its mousemove listener once per drag, so its callback
  // closes over a single render. Deltas must therefore accumulate through the
  // state updater — reading the width off a render-scoped value (or a ref written
  // during render) drops every event that lands before React re-renders.
  const widthRef = useRef(sidebarWidth)

  const applyResizeDelta = (delta: number): void => {
    setWidthDraft((current) => {
      const next = clampSidebarWidth((current ?? savedWidth) + delta)
      // Mirrored for onResizeEnd, which has no access to the updated state.
      widthRef.current = next
      return next
    })
  }

  // Inline session rename. Only the active session can be renamed (Pi's rename
  // targets it), and it's reachable from two spots — the Current Session panel
  // (`'current'`) and its highlighted row in Recent Sessions (`'recent'`).
  const [renamingWhere, setRenamingWhere] = useState<'current' | 'recent' | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameCancelRef = useRef(false)

  const startSessionRename = (where: 'current' | 'recent'): void => {
    renameCancelRef.current = false
    // Prefill with the explicit name only; a timestamp/guid is not a name.
    setRenameValue(sessionState?.sessionName ?? '')
    setRenamingWhere(where)
  }

  // Single commit path (both Enter and Escape blur the input, which lands here).
  const finishSessionRename = (): void => {
    const cancelled = renameCancelRef.current
    renameCancelRef.current = false
    setRenamingWhere(null)
    // Pi's set_session_name RPC rejects an empty name ("cannot be empty"), so an
    // empty commit is a no-op (keeps the current name) rather than a doomed call.
    const trimmed = renameValue.trim()
    if (!cancelled && trimmed) setSessionName(trimmed)
  }

  const renderRenameInput = (): React.JSX.Element => (
    <input
      type="text"
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          renameCancelRef.current = true
          e.currentTarget.blur()
        }
      }}
      onBlur={finishSessionRename}
      placeholder="Session name"
      autoFocus
      className="min-w-0 flex-1 rounded border border-border-strong bg-card px-2 py-0.5 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none"
    />
  )

  // Archived sessions live in their own collapsible section; Recent excludes them.
  const activeSessions = useMemo(
    () => sessionList.filter((s) => !(s.sessionId in archivedSessions)),
    [sessionList, archivedSessions]
  )
  const archivedList = useMemo(
    () => sessionList.filter((s) => s.sessionId in archivedSessions),
    [sessionList, archivedSessions]
  )

  // Group recents by project folder (path). Display name = folder basename.
  const recentGroups = useMemo((): RecentSessionGroup[] => {
    // Group key is case-fold only on win32 (shared path-compare helper).
    const byProject = new Map<string, { displayPath: string; sessions: SessionListItem[] }>()
    for (const session of activeSessions) {
      const displayPath = session.projectPath || 'unknown'
      const key = pathGroupKey(displayPath)
      const existing = byProject.get(key)
      if (existing) existing.sessions.push(session)
      else byProject.set(key, { displayPath, sessions: [session] })
    }

    const groups: RecentSessionGroup[] = []
    for (const { displayPath, sessions } of byProject.values()) {
      const sorted = [...sessions].sort((a, b) => b.lastModified - a.lastModified)
      const latest = sorted[0]
      if (!latest) continue
      const folderName =
        latest.projectName?.trim() ||
        displayPath.split(/[\\/]/).filter(Boolean).pop() ||
        displayPath
      groups.push({
        projectPath: displayPath,
        projectName: folderName,
        sessions: sorted.slice(0, MAX_SESSIONS_PER_GROUP),
        latest,
      })
    }

    groups.sort((a, b) => b.latest.lastModified - a.latest.lastModified)
    return groups.slice(0, MAX_RECENT_GROUPS)
  }, [activeSessions])

  // Explicit expand/collapse overrides. Folders default to collapsed except the
  // one that contains the active session (until the user toggles).
  const [expandOverride, setExpandOverride] = useState<Record<string, boolean>>({})

  const activeProjectKey = useMemo(() => {
    if (!sessionState?.sessionFile) return null
    const active = activeSessions.find((s) => s.path === sessionState.sessionFile)
    return active ? pathGroupKey(active.projectPath || 'unknown') : null
  }, [activeSessions, sessionState?.sessionFile])

  const isGroupExpanded = (projectPath: string): boolean => {
    const key = pathGroupKey(projectPath)
    if (Object.prototype.hasOwnProperty.call(expandOverride, key)) {
      return expandOverride[key]
    }
    return activeProjectKey === key
  }

  const toggleGroup = (projectPath: string): void => {
    const key = pathGroupKey(projectPath)
    setExpandOverride((prev) => ({
      ...prev,
      [key]: !isGroupExpanded(projectPath),
    }))
  }

  const recentSessionsForWorkspace = useMemo(() => {
    if (!activeWorkspace?.path) return []
    return activeSessions
      .filter((session) => pathsEqual(session.projectPath, activeWorkspace.path))
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, MAX_SESSIONS_PER_GROUP)
  }, [activeSessions, activeWorkspace?.path])

  const startNewSession = async (): Promise<void> => {
    if (!activeWorkspace) {
      setCurrentView('home')
      return
    }
    setCurrentView('chat')
    await createNewSession()
  }

  const openProject = async (): Promise<void> => {
    const path = await window.piDesktop.system.openDialog({ title: 'Open Project' })
    if (path) await openFolderAsWorkspace(path)
  }

  const openToolView = (view: 'packages' | 'notes' | 'skills' | 'diagnostics' | 'settings'): void => {
    setWorkflowPanelOpen(false)
    setCurrentView(view)
  }

  // Workspace auto-switch/create + session switch + show Chat, shared with the
  // session panel and the quick switcher.
  const openSession = useAppStore((state) => state.openSessionItem)

  const handleSessionRightClick = (e: React.MouseEvent, session: SessionListItem): void => {
    // Prevent the app-level document-level contextmenu handler from also
    // firing (which would build & show a *default* menu on top of ours).
    // React's synthetic stopPropagation isn't enough — that handler is
    // attached to `document` and fires on native bubbling.
    e.nativeEvent.stopPropagation()
    const isActive = sessionState?.sessionFile === session.path
    showMenu(
      e,
      buildSessionContextMenu(session, session.sessionId in archivedSessions, {
        onOpen: (s) => { openSession(s) },
        onArchive: (id) => archiveSession(id),
        onUnarchive: (id) => unarchiveSession(id),
        onDelete: (s) => { deleteSession(s) },
        // Rename only offered for the active session (Pi renames the active one).
        onRename: isActive ? () => startSessionRename('recent') : undefined,
        onRuns: (s) => openWorkflowRunsForSession(resolveRunSessionId(s.piSessionId, s.sessionId) ?? s.sessionId),
      })
    )
  }

  // Right-click menu for the Current Session panel — same active session, so
  // just the rename affordance.
  const handleCurrentSessionRightClick = (e: React.MouseEvent): void => {
    e.nativeEvent.stopPropagation()
    showMenu(e, [
      {
        id: 'current-session-rename',
        label: 'Rename…',
        icon: <Pencil size={14} />,
        action: () => startSessionRename('current'),
      },
    ])
  }

  const renderSessionRow = (
    session: SessionListItem,
    options?: { nested?: boolean }
  ): React.JSX.Element => {
    const labels = getSessionRowLabels(session)
    // Runs are keyed by Pi's header UUID, never the filename stem (the
    // tags/archive registry key). The stem suffix IS the UUID, so it is a
    // safe fallback when a row's header is unreadable.
    const workflowSessionId = resolveRunSessionId(session.piSessionId, session.sessionId) ?? session.sessionId
    const runtime = Object.values(sessionRuntimes).find((item) => item.sessionPath && pathsEqual(item.sessionPath, session.path))
    const isActive = sessionState?.sessionFile === session.path || runtime?.runtimeId === activeSessionRuntimeId
    const nested = options?.nested ?? false

    // Inline rename for the active row.
    if (isActive && renamingWhere === 'recent') {
      return (
        <div
          key={session.path}
          className={clsx(
            'flex w-full items-center gap-2 rounded bg-card px-2 py-1.5',
            nested && 'pl-2'
          )}
        >
          <Clock size={12} className="shrink-0 text-muted" />
          {renderRenameInput()}
        </div>
      )
    }

    return (
      <div key={session.path} className="group relative">
        <button
          onClick={() => openSession(session)}
          onDoubleClick={() => { if (isActive) startSessionRename('recent') }}
          onContextMenu={(e) => handleSessionRightClick(e, session)}
          // The full title leads, so a preview too long for the current width is
          // still readable on hover.
          title={`${labels.title}\n\n${isActive
            ? 'Click to open · double-click to rename · right-click for actions'
            : 'Click to open · right-click for actions'}`}
          className={clsx(
            'flex w-full items-center gap-2 rounded px-2 py-1.5 pr-7 text-left text-sm transition-colors',
            nested && 'pl-2',
            isActive
              ? 'bg-card text-primary'
              : 'hover:bg-highlight text-muted hover:text-secondary'
          )}
        >
          <Clock size={12} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate">{labels.title}</div>
            {/* The title is now the session's name or first message, so the time it
                displaced moves here. Recent rows are already grouped by workspace,
                which makes the project name the less useful of the two subtitles —
                the home screen, which is not grouped, shows the project instead. */}
            <div className="truncate text-[11px] text-faint">
              {formatRelativeTime(session.lastModified, Date.now())}
            </div>
          </div>
          {runtime && <SessionRuntimeIndicator runtime={runtime} />}
        </button>
        {/* Sibling (not child) of the row button, so no nested interactive
            elements: the row's click/double-click/context-menu never fire for
            this icon. Shows an empty filtered state when the session has no runs. */}
        <button
          type="button"
          onClick={() => openWorkflowRunsForSession(workflowSessionId)}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-faint opacity-0 transition-opacity hover:bg-highlight hover:text-accent-fg focus-visible:opacity-100 group-hover:opacity-100"
          title="Workflow runs for this session"
          aria-label="Workflow runs for this session"
        >
          <WorkflowIcon size={12} />
        </button>
      </div>
    )
  }

  const renderRecentGroup = (group: RecentSessionGroup): React.JSX.Element => {
    const expanded = isGroupExpanded(group.projectPath)
    const isCurrentFolder =
      !!activeWorkspace?.path && pathsEqual(activeWorkspace.path, group.projectPath)
    const count = group.sessions.length

    return (
      <div key={pathGroupKey(group.projectPath)} className="mb-1">
        {/* Folder header — primary grouping unit */}
        <button
          type="button"
          onClick={() => toggleGroup(group.projectPath)}
          title={group.projectPath}
          aria-expanded={expanded}
          className={clsx(
            'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors',
            isCurrentFolder
              ? 'bg-accent-bg/40 text-primary'
              : 'text-secondary hover:bg-highlight hover:text-primary'
          )}
        >
          <ChevronDown
            size={12}
            className={clsx(
              'shrink-0 text-dim transition-transform',
              !expanded && '-rotate-90'
            )}
          />
          <FolderOpen
            size={12}
            className={clsx('shrink-0', isCurrentFolder ? 'text-accent-fg' : 'text-dim')}
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {group.projectName}
          </span>
          <span className="shrink-0 text-[10px] text-faint">
            {count}
          </span>
        </button>

        {expanded && (
          <div className="mt-0.5 space-y-0.5 border-l border-border/70 ml-3 pl-1">
            {group.sessions.map((session) =>
              renderSessionRow(session, { nested: true })
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
    <aside
      className="flex shrink-0 flex-col border-r border-border bg-app"
      style={{ width: sidebarWidth }}
    >
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <StatusPopover />
          {/* Compact Home replaces the duplicate Pi-activity popover: workspace
              activity already lives in the switcher row, tab icons, and switcher
              dropdown, so the header keeps only system status + Home. */}
          <button
            type="button"
            onClick={() => setCurrentView('home')}
            className={clsx(
              'rounded p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus',
              currentView === 'home'
                ? 'bg-card text-accent-fg'
                : 'text-muted hover:bg-surface-hover hover:text-primary'
            )}
            title="Home (Esc to launcher)"
            aria-label="Home"
          >
            <Home size={16} />
          </button>
          <span className="text-sm font-medium text-primary">Pi Desktop</span>
        </div>
        <button
          onClick={toggleSidebar}
          className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary"
          title="Close sidebar"
          aria-label="Close sidebar"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Project + primary action */}
      <div className="border-b border-border pb-3">
        <div className="flex items-center justify-between px-3 pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Project</div>
          <button
            type="button"
            onClick={() => void openProject()}
            className="rounded p-1 text-muted transition-colors hover:bg-highlight hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
            title="Open project folder (Ctrl/Cmd+O)"
            aria-label="Open project folder"
          >
            <FolderOpen size={14} />
          </button>
        </div>
        <WorkspaceSwitcher onOpenProject={() => void openProject()} />
        <div className="px-3">
          <button
            type="button"
            onClick={() => void startNewSession()}
            disabled={!activeWorkspace}
            className="group flex w-full items-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-white shadow-sm shadow-accent/20 transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
            title={activeWorkspace ? 'Start a new session in this project (Ctrl/Cmd+N)' : 'Open a project first'}
          >
            <Plus size={15} className="shrink-0 transition-transform group-hover:rotate-90" />
            <span className="flex-1 text-left">New session</span>
            <kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/75">Ctrl N</kbd>
          </button>
          <div className="mt-1.5 px-1 text-[11px] text-faint">
            {activeWorkspace ? `Starts in ${activeWorkspace.name}` : 'Open a project to begin'}
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="space-y-3 border-b border-border px-2 py-3">
        <div>
          <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Workspace</div>
          <div className="space-y-0.5">
            <SidebarItem
              icon={<MessageSquare size={14} />}
              label="Chat"
              active={currentView === 'chat'}
              onClick={() => setCurrentView('chat')}
            />
            <SidebarItem
              icon={<FolderOpen size={14} />}
              label="Sessions"
              active={currentView === 'sessions'}
              onClick={() => {
                setSessionsScope('current')
                setCurrentView('sessions')
              }}
              title="Sessions in this project"
            />
            <SidebarItem
              icon={<Plus size={14} />}
              label="New task"
              active={false}
              onClick={() => setTaskLauncherOpen(true)}
              title="Start a task in a new Pi session"
            />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
            <span>Activity</span>
            {activeWorkspace && (
              <span className="min-w-0 truncate normal-case">· {activeWorkspace.name}</span>
            )}
          </div>
          <div className="space-y-0.5">
            <SidebarItem
              icon={<LayoutDashboard size={14} />}
              label="Mission Control"
              active={currentView === 'mission-control'}
              onClick={() => {
                setWorkflowPanelOpen(false)
                setCurrentView('mission-control')
              }}
              title="All background sessions and workflows"
            />
            <SidebarItem
              icon={<WorkflowIcon size={14} />}
              label="Workflows"
              // Only highlighted when THIS project's scope is open, so it never
              // fights the Tools' global "All Workflows" entry. With no project
              // open the entry falls back to the global list (same as the old
              // behavior) but stays unhighlighted.
              active={
                !!activeWorkspace &&
                workflowPanelOpen &&
                !workflowPanelFilter &&
                workflowPanelWorkspaceId === activeWorkspace.id
              }
              onClick={() => openWorkflowRunsForWorkspace(activeWorkspace?.id ?? null)}
              title={activeWorkspace ? `Workflow runs in ${activeWorkspace.name}` : 'All workflow runs (no project open)'}
            />
            <SidebarItem
              icon={<Activity size={14} />}
              label="Timeline"
              active={currentView === 'timeline'}
              onClick={() => setCurrentView('timeline')}
              title={activeWorkspace ? `Timeline for ${activeWorkspace.name}` : 'Timeline'}
            />
          </div>
        </div>
      </nav>

      {/* Current session info */}
      {sessionState && (
        renamingWhere === 'current' ? (
          <div className="mx-3 mt-2 rounded-md bg-surface p-3">
            <div className="text-xs font-medium text-muted uppercase tracking-wider">Current Session</div>
            <div className="mt-1.5 flex">{renderRenameInput()}</div>
            {sessionState.model && (
              <div className="mt-1 text-xs text-dim">{sessionState.model.name}</div>
            )}
            <div className="mt-1 text-xs text-dim">{sessionState.messageCount} messages</div>
          </div>
        ) : (
          <div className="group relative mx-3 mt-2">
            <button
              type="button"
              onClick={() => setCurrentView('chat')}
              onDoubleClick={() => startSessionRename('current')}
              onContextMenu={handleCurrentSessionRightClick}
              className="w-full rounded-md bg-surface p-3 pr-9 text-left transition-colors hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-border-strong"
              title="Open current session in chat · double-click to rename"
            >
              <div className="text-xs font-medium text-muted uppercase tracking-wider">Current Session</div>
              <div className="mt-1.5 text-sm text-primary truncate">
                {getSessionTitle(sessionState.sessionName, sessionState.sessionId)}
              </div>
              {sessionState.model && (
                <div className="mt-1 text-xs text-dim">
                  {sessionState.model.name}
                </div>
              )}
              <div className="mt-1 text-xs text-dim">
                {sessionState.messageCount} messages
              </div>
            </button>
            {/* Sibling overlay — the panel above stays a single non-nested button. */}
            <button
              type="button"
              onClick={() => openWorkflowRunsForSession(sessionState.sessionId)}
              className="absolute right-2 top-3 rounded p-1.5 text-faint opacity-0 transition-opacity hover:bg-highlight hover:text-accent-fg focus-visible:opacity-100 group-hover:opacity-100"
              title="Workflow runs for this session"
              aria-label="Workflow runs for this session"
            >
              <WorkflowIcon size={13} />
            </button>
          </div>
        )
      )}

      {/* Recent sessions for the active project. Cross-project history stays in Sessions. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <div className="mb-1 flex items-center justify-between px-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
            {activeWorkspace ? `Recent in ${activeWorkspace.name}` : 'Recent sessions'}
          </div>
          <button
            type="button"
            onClick={() => {
              setSessionsScope('all')
              setCurrentView('sessions')
            }}
            className="text-[11px] text-muted transition-colors hover:text-accent-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
          >
            View all
          </button>
        </div>
        {activeWorkspace ? (
          recentSessionsForWorkspace.length === 0 ? (
            <div className="mx-2 mt-2 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-faint">
              No sessions in this project yet.
              <button
                type="button"
                onClick={() => void startNewSession()}
                className="mt-1 block w-full text-accent-fg transition-colors hover:text-accent"
              >
                Start one now
              </button>
            </div>
          ) : (
            <div className="space-y-0.5">
              {recentSessionsForWorkspace.map((session) => renderSessionRow(session))}
            </div>
          )
        ) : recentGroups.length === 0 ? (
          <div className="mx-2 mt-2 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-faint">
            Open a project to see its sessions.
          </div>
        ) : (
          recentGroups.map(renderRecentGroup)
        )}
      </div>

      {/* Archived sessions (collapsible) */}
      {archivedList.length > 0 && (
        <div className="shrink-0 border-t border-border px-2 py-1">
          <button
            onClick={() => setArchivedOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-dim hover:text-secondary transition-colors"
            title={archivedOpen ? 'Collapse archived sessions' : 'Expand archived sessions'}
          >
            <ChevronDown
              size={12}
              className={clsx('shrink-0 transition-transform', !archivedOpen && '-rotate-90')}
            />
            <Archive size={12} className="shrink-0" />
            <span>Archived ({archivedList.length})</span>
          </button>
          {archivedOpen && (
            <div className="max-h-48 overflow-y-auto pb-1">
              {archivedList.map((session) => renderSessionRow(session))}
            </div>
          )}
        </div>
      )}

      {/* Secondary tools stay available without competing with project/session work. */}
      <div className="shrink-0 border-t border-border px-2 py-2">
        <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Tools</div>
        <div className="grid grid-cols-2 gap-0.5">
          <SidebarItem
            compact
            icon={<Package size={13} />}
            label="Packages"
            active={currentView === 'packages'}
            onClick={() => openToolView('packages')}
          />
          <SidebarItem
            compact
            icon={<StickyNote size={13} />}
            label="Notes"
            active={currentView === 'notes'}
            onClick={() => openToolView('notes')}
          />
          <SidebarItem
            compact
            icon={<Sparkles size={13} />}
            label="Skills"
            active={currentView === 'skills'}
            onClick={() => openToolView('skills')}
          />
          <SidebarItem
            compact
            icon={<Stethoscope size={13} />}
            label="Diagnostics"
            active={currentView === 'diagnostics'}
            onClick={() => openToolView('diagnostics')}
          />
          {/* Global workflow list lives here — "browse everything" territory —
              so the Activity section stays scoped to the current project. */}
          <SidebarItem
            compact
            icon={<WorkflowIcon size={13} />}
            label="All Workflows"
            // Highlighted only when the global scope is open (never alongside
            // the Activity entry, whose active state requires a workspace id).
            active={workflowPanelOpen && !workflowPanelFilter && workflowPanelWorkspaceId === null}
            onClick={() => openWorkflowRunsForWorkspace(null)}
            title="Workflow runs from every project"
          />
          <SidebarItem
            compact
            icon={<Settings size={13} />}
            label="Settings"
            active={currentView === 'settings'}
            onClick={() => openToolView('settings')}
          />
        </div>
      </div>
      {SessionMenu}
    </aside>
    <ResizeHandle
      onResize={applyResizeDelta}
      onResizeEnd={() => void saveSidebarWidth(widthRef.current)}
    />
    </>
  )
}

// ─── Workspace Switcher ──────────────────────────────────────────────────────

function WorkspaceSwitcher({ onOpenProject }: { onOpenProject: () => void }): React.JSX.Element {
  const workspaces = useAppStore((state) => state.workspaces)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const activateWorkspace = useAppStore((state) => state.activateWorkspace)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const renameWorkspace = useAppStore((state) => state.renameWorkspace)
  const changeWorkspaceFolder = useAppStore((state) => state.changeWorkspaceFolder)
  const pendingPromptCounts = useAppStore((state) => state.pendingPromptCounts)
  const workspaceActivity = useAppStore((state) => state.workspaceActivity)
  const { show: showContextMenu, ContextMenuComponent: WorkspaceContextMenu } = useContextMenu()

  // Prompts held for workspaces other than the active one — the active
  // workspace's prompt is already on screen, so only elsewhere needs a badge.
  const promptsWaitingElsewhere = countPromptsWaitingElsewhere(
    pendingPromptCounts,
    activeWorkspace?.id ?? null
  )

  // Background work in non-active workspaces, condensed to one header dot.
  const backgroundActivity = summarizeBackgroundActivity(
    workspaceActivity,
    activeWorkspace?.id ?? null
  )

  const [isOpen, setIsOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [newName, setNewName] = useState('')

  const handleRename = async () => {
    if (!activeWorkspace || !newName.trim()) return
    await renameWorkspace(activeWorkspace.id, newName.trim())
    setIsRenaming(false)
  }

  const startRenaming = () => {
    setNewName(activeWorkspace?.name ?? '')
    setIsRenaming(true)
    setIsOpen(false)
  }

  const handleChangeFolder = async () => {
    if (!activeWorkspace) return
    const path = await window.piDesktop.system.openDialog({ title: 'Select Workspace Folder' })
    if (path) await changeWorkspaceFolder(activeWorkspace.id, path)
  }

  const handleWorkspaceContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    showContextMenu(e, [
      {
        id: 'rename',
        label: 'Rename',
        icon: <Pencil size={14} />,
        disabled: !activeWorkspace,
        action: startRenaming,
      },
      {
        id: 'change-folder',
        label: 'Change folder…',
        icon: <FolderOpen size={14} />,
        disabled: !activeWorkspace,
        action: () => {
          void handleChangeFolder()
        },
      },
    ])
  }

  return (
    <div className="px-3 py-2">
      {/* Current workspace */}
      {isRenaming ? (
        <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-2">
          <Layers size={14} style={{ color: activeWorkspace?.color ?? '#6b7280' }} />
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleRename()
              } else if (e.key === 'Escape') {
                setIsRenaming(false)
              }
            }}
            onBlur={handleRename}
            placeholder="Workspace name"
            className="min-w-0 flex-1 rounded border border-border-strong bg-card px-2 py-1 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none"
            autoFocus
          />
        </div>
      ) : (
        <button
          onClick={() => setIsOpen(!isOpen)}
          onDoubleClick={startRenaming}
          onContextMenu={handleWorkspaceContextMenu}
          title="Click to switch · double-click to rename · right-click for options"
          className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-primary hover:bg-surface-hover transition-colors"
        >
          <div className="flex min-w-0 items-center gap-2 text-left">
            <Layers size={14} className="shrink-0" style={{ color: activeWorkspace?.color ?? '#6b7280' }} />
            <div className="min-w-0">
              <div className="truncate text-sm">{activeWorkspace?.name ?? 'No workspace'}</div>
              {activeWorkspace && (
                <div className="truncate text-[10px] text-faint">{activeWorkspace.path}</div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {backgroundActivity && (
              <span
                className={clsx(
                  'h-2 w-2 rounded-full',
                  backgroundActivity.colorClass,
                  backgroundActivity.pulse && 'animate-pulse'
                )}
                title={backgroundActivity.label}
              />
            )}
            {promptsWaitingElsewhere > 0 && (
              <span
                className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] text-warning"
                title={`${formatPromptsWaiting(promptsWaitingElsewhere)} in other workspaces`}
              >
                {promptsWaitingElsewhere}
              </span>
            )}
            <ChevronDown
              size={14}
              className={clsx(
                'text-dim transition-transform',
                isOpen && 'rotate-180'
              )}
            />
          </div>
        </button>
      )}
      {WorkspaceContextMenu}

      {/* Dropdown */}
      {isOpen && (
        <div className="mt-1 rounded-md border border-border bg-surface py-1 animate-fade-in">
          {/* Workspace list */}
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className="group flex items-center justify-between px-3 py-1.5 hover:bg-surface-hover"
            >
              <button
                onClick={() => {
                  void activateWorkspace(ws.id)
                  setIsOpen(false)
                }}
                className="flex items-center gap-2 min-w-0 flex-1 text-left"
              >
                <div
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: ws.color }}
                />
                <span className="text-sm text-secondary truncate">{ws.name}</span>
                {ws.id === activeWorkspace?.id && (
                  <Check size={12} className="shrink-0 text-success" />
                )}
                {ws.id !== activeWorkspace?.id && (pendingPromptCounts[ws.id] ?? 0) > 0 && (
                  <span
                    className="shrink-0 rounded bg-warning-bg px-1.5 py-0.5 text-[10px] text-warning"
                    title={formatPromptsWaiting(pendingPromptCounts[ws.id])}
                  >
                    {pendingPromptCounts[ws.id]}
                  </span>
                )}
                {(() => {
                  const indicator = workspaceActivityIndicator(workspaceActivity[ws.id])
                  return indicator ? (
                    <span
                      className={clsx(
                        'h-2 w-2 shrink-0 rounded-full',
                        indicator.colorClass,
                        indicator.pulse && 'animate-pulse'
                      )}
                      title={indicator.label}
                    />
                  ) : null
                })()}
              </button>
              {workspaces.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeWorkspace(ws.id)
                  }}
                  className="rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-error transition-all"
                  title="Remove workspace"
                  aria-label="Remove workspace"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}

          <button
            type="button"
            onClick={() => {
              setIsOpen(false)
              onOpenProject()
            }}
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
          >
            <FolderOpen size={12} />
            Open project…
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Sidebar Item ────────────────────────────────────────────────────────────

function SidebarItem({
  icon,
  label,
  active,
  onClick,
  compact = false,
  title,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  compact?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus',
        compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm',
        active
          ? 'bg-card text-primary'
          : 'text-muted hover:bg-highlight hover:text-secondary'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}
