import { useAppStore } from '../store'
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
  Package,
  Layers,
  ChevronDown,
  Check,
  Trash2,
  StickyNote,
  Archive,
  Sparkles,
  Pencil,
} from 'lucide-react'
import { useState, useRef } from 'react'
import { StatusPopover } from './status-popover'
import { useContextMenu, buildSessionContextMenu } from './context-menu'
import { getSessionRowLabels } from './sidebar-session-labels'
import type { SessionListItem } from '../../../shared/ipc-contracts'

export function Sidebar(): React.JSX.Element {
  const currentView = useAppStore((state) => state.currentView)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const sessionState = useAppStore((state) => state.sessionState)
  const sessionList = useAppStore((state) => state.sessionList)
  const createNewSession = useAppStore((state) => state.createNewSession)
  const switchSession = useAppStore((state) => state.switchSession)
  const switchWorkspace = useAppStore((state) => state.switchWorkspace)
  const workspaces = useAppStore((state) => state.workspaces)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const archivedSessions = useAppStore((state) => state.archivedSessions)
  const archiveSession = useAppStore((state) => state.archiveSession)
  const unarchiveSession = useAppStore((state) => state.unarchiveSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const setSessionName = useAppStore((state) => state.setSessionName)

  const { show: showMenu, ContextMenuComponent: SessionMenu } = useContextMenu()

  const [archivedOpen, setArchivedOpen] = useState(false)

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
  const recentSessions = sessionList.filter((s) => !(s.sessionId in archivedSessions)).slice(0, 20)
  const archivedList = sessionList.filter((s) => s.sessionId in archivedSessions)

  const openSession = async (session: SessionListItem): Promise<void> => {
    // Auto-switch workspace if session is from a different project
    if (session.projectPath && session.projectPath !== activeWorkspace?.path) {
      const matchingWs = workspaces.find((w) => w.path === session.projectPath)
      if (matchingWs) {
        await switchWorkspace(matchingWs.id)
      } else {
        await useAppStore.getState().createWorkspace(session.projectName, session.projectPath)
        const updated = useAppStore.getState().workspaces
        const newWs = updated.find((w) => w.path === session.projectPath)
        if (newWs) await switchWorkspace(newWs.id)
      }
    }
    switchSession(session.path)
    // Bring the chat into view (may be on Settings/Notes/etc.). In-app switches
    // keep their remembered scroll position, so no force-to-bottom here.
    setCurrentView('chat')
  }

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

  const renderSessionRow = (session: SessionListItem): React.JSX.Element => {
    const labels = getSessionRowLabels(session)
    const isActive = sessionState?.sessionFile === session.path

    // Inline rename for the active row.
    if (isActive && renamingWhere === 'recent') {
      return (
        <div
          key={session.path}
          className="flex w-full items-center gap-2 rounded bg-card px-2 py-1.5"
        >
          <Clock size={12} className="shrink-0 text-muted" />
          {renderRenameInput()}
        </div>
      )
    }

    return (
      <button
        key={session.path}
        onClick={() => openSession(session)}
        onDoubleClick={() => { if (isActive) startSessionRename('recent') }}
        onContextMenu={(e) => handleSessionRightClick(e, session)}
        title={isActive
          ? 'Click to open · double-click to rename · right-click for actions'
          : 'Click to open · right-click for actions'}
        className={clsx(
          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
          isActive
            ? 'bg-card text-primary'
            : 'hover:bg-highlight text-muted hover:text-secondary'
        )}
      >
        <Clock size={12} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate">{labels.title}</div>
          {labels.subtitle && (
            <div className="text-[10px] text-faint truncate">{labels.subtitle}</div>
          )}
        </div>
      </button>
    )
  }

  return (
    <aside className="flex w-[calc(16rem_+_16px)] flex-col border-r border-border bg-app">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <StatusPopover />
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

      {/* Workspace switcher */}
      <WorkspaceSwitcher />

      {/* New session button */}
      <div className="px-3 py-2">
        <button
          onClick={createNewSession}
          className="flex w-full items-center gap-2 rounded-md bg-card px-3 py-2 text-sm text-primary hover:bg-elevated transition-colors"
        >
          <Plus size={14} />
          New Session
        </button>
      </div>

      {/* Navigation */}
      <nav className="space-y-0.5 px-2 py-1">
        <SidebarItem
          icon={<Home size={14} />}
          label="Home"
          active={currentView === 'home'}
          onClick={() => setCurrentView('home')}
        />
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
          onClick={() => setCurrentView('sessions')}
        />
        <SidebarItem
          icon={<Activity size={14} />}
          label="Timeline"
          active={currentView === 'timeline'}
          onClick={() => setCurrentView('timeline')}
        />
        <SidebarItem
          icon={<Package size={14} />}
          label="Packages"
          active={currentView === 'packages'}
          onClick={() => setCurrentView('packages')}
        />
        <SidebarItem
          icon={<StickyNote size={14} />}
          label="Notes"
          active={currentView === 'notes'}
          onClick={() => setCurrentView('notes')}
        />
        <SidebarItem
          icon={<Sparkles size={14} />}
          label="Skills"
          active={currentView === 'skills'}
          onClick={() => setCurrentView('skills')}
        />
        <SidebarItem
          icon={<Settings size={14} />}
          label="Settings"
          active={currentView === 'settings'}
          onClick={() => setCurrentView('settings')}
        />
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
          <button
            type="button"
            onClick={() => setCurrentView('chat')}
            onDoubleClick={() => startSessionRename('current')}
            onContextMenu={handleCurrentSessionRightClick}
            className="mx-3 mt-2 rounded-md bg-surface p-3 text-left transition-colors hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-border-strong"
            title="Open current session in chat · double-click to rename"
          >
            <div className="text-xs font-medium text-muted uppercase tracking-wider">Current Session</div>
            <div className="mt-1.5 text-sm text-primary truncate">
              {sessionState.sessionName || sessionState.sessionId || 'Unnamed'}
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
        )
      )}

      {/* Recent sessions */}
      <div className="mt-4 flex-1 overflow-y-auto px-2">
        <div className="px-2 py-1 text-xs font-medium text-dim uppercase tracking-wider">
          Recent Sessions
        </div>
        {recentSessions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-faint">No sessions yet</div>
        ) : (
          recentSessions.map(renderSessionRow)
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
              {archivedList.map(renderSessionRow)}
            </div>
          )}
        </div>
      )}
      {SessionMenu}
    </aside>
  )
}

// ─── Workspace Switcher ──────────────────────────────────────────────────────

function WorkspaceSwitcher(): React.JSX.Element {
  const workspaces = useAppStore((state) => state.workspaces)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const switchWorkspace = useAppStore((state) => state.switchWorkspace)
  const createWorkspace = useAppStore((state) => state.createWorkspace)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const renameWorkspace = useAppStore((state) => state.renameWorkspace)
  const changeWorkspaceFolder = useAppStore((state) => state.changeWorkspaceFolder)
  const { show: showContextMenu, ContextMenuComponent: WorkspaceContextMenu } = useContextMenu()

  const [isOpen, setIsOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')

  const handleCreate = async () => {
    if (!newName.trim() || !newPath.trim()) return
    await createWorkspace(newName.trim(), newPath.trim())
    setNewName('')
    setNewPath('')
    setIsCreating(false)
  }

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

  const handleSelectFolder = async () => {
    const path = await window.piDesktop.system.openDialog({ title: 'Select Workspace Folder' })
    if (path) setNewPath(path)
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
          <div className="flex items-center gap-2 min-w-0">
            <Layers size={14} style={{ color: activeWorkspace?.color ?? '#6b7280' }} />
            <span className="truncate">{activeWorkspace?.name ?? 'No workspace'}</span>
          </div>
          <ChevronDown
            size={14}
            className={clsx(
              'shrink-0 text-dim transition-transform',
              isOpen && 'rotate-180'
            )}
          />
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
                  switchWorkspace(ws.id)
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

          {/* Create new */}
          {isCreating ? (
            <div className="border-t border-border px-3 py-2 space-y-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Workspace name"
                className="w-full rounded border border-border-strong bg-card px-2 py-1 text-xs text-primary placeholder:text-faint focus:border-focus focus:outline-none"
                autoFocus
              />
              <div className="flex gap-1">
                <input
                  type="text"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="/path/to/project"
                  className="flex-1 rounded border border-border-strong bg-card px-2 py-1 text-xs text-primary placeholder:text-faint focus:border-focus focus:outline-none"
                />
                <button
                  onClick={handleSelectFolder}
                  className="rounded border border-border-strong px-2 py-1 text-xs text-muted hover:bg-elevated"
                >
                  ...
                </button>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim() || !newPath.trim()}
                  className="flex-1 rounded bg-accent px-2 py-1 text-xs text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  Create
                </button>
                <button
                  onClick={() => setIsCreating(false)}
                  className="rounded px-2 py-1 text-xs text-muted hover:text-primary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setIsCreating(true)}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted hover:bg-surface-hover hover:text-secondary transition-colors"
            >
              <Plus size={12} />
              Add Workspace
            </button>
          )}
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
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-card text-primary'
          : 'hover:bg-highlight text-muted hover:text-secondary'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
