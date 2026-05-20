import { useAppStore } from '../store'
import { FolderOpen, Plus, Clock, Search, ChevronRight, ChevronDown, FolderTree, Tag, X } from 'lucide-react'
import { useState, useMemo } from 'react'
import { clsx } from 'clsx'
import type { SessionListItem } from '../../../shared/ipc-contracts'

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

  const [searchQuery, setSearchQuery] = useState('')
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [showAllProjects, setShowAllProjects] = useState(true)

  // Group sessions by project
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, SessionListItem[]>()

    for (const session of sessionList) {
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
  }, [sessionList])

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
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      return next
    })
  }

  const totalSessions = sessionList.length
  const totalProjects = groupedSessions.length

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FolderOpen size={20} className="text-neutral-400" />
            <h1 className="text-lg font-semibold text-neutral-200">Sessions</h1>
            <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-500">
              {totalSessions} sessions · {totalProjects} projects
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={refreshSessionList}
              className="rounded-md px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              Refresh
            </button>
            <button
              onClick={createNewSession}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 transition-colors"
            >
              <Plus size={14} />
              New Session
            </button>
          </div>
        </div>

        {/* Filter controls */}
        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              placeholder="Search sessions or projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 py-2 pl-9 pr-4 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <button
            onClick={() => setShowAllProjects(!showAllProjects)}
            className={clsx(
              'rounded-md px-3 py-2 text-xs transition-colors',
              showAllProjects
                ? 'bg-blue-900/30 text-blue-400'
                : 'bg-neutral-800 text-neutral-400 hover:text-neutral-300'
            )}
          >
            {showAllProjects ? 'All Projects' : 'Current Only'}
          </button>
        </div>

        {/* Current workspace indicator */}
        {activeWorkspace && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-neutral-900 border border-neutral-800 px-4 py-2">
            <FolderTree size={14} className="text-neutral-500" />
            <span className="text-xs text-neutral-400">Current workspace:</span>
            <span className="text-sm text-neutral-200 font-medium">{activeWorkspace.name}</span>
            <span className="text-xs text-neutral-500 truncate">{activeWorkspace.path}</span>
          </div>
        )}

        {/* Sessions grouped by project */}
        {filteredGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-neutral-500">
            <FolderOpen size={32} className="mb-3 text-neutral-600" />
            <p className="text-sm">
              {searchQuery ? 'No sessions match your search' : 'No sessions yet'}
            </p>
            {!searchQuery && (
              <button
                onClick={createNewSession}
                className="mt-3 text-sm text-blue-400 hover:text-blue-300"
              >
                Create your first session
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredGroups.map(([projectPath, sessions]) => {
              const isExpanded = expandedProjects.has(projectPath) || filteredGroups.length <= 3
              const isCurrentProject = projectPath === activeWorkspace?.path
              const projectName = sessions[0]?.projectName ?? 'Unknown'
              const latestSession = sessions[0]

              return (
                <div
                  key={projectPath}
                  className={clsx(
                    'rounded-lg border overflow-hidden',
                    isCurrentProject
                      ? 'border-blue-800/40 bg-blue-950/10'
                      : 'border-neutral-800 bg-neutral-900/30'
                  )}
                >
                  {/* Project header */}
                  <button
                    onClick={() => toggleProject(projectPath)}
                    className="flex w-full items-center gap-2 px-4 py-2.5 hover:bg-neutral-800/30 transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} className="text-neutral-500 shrink-0" />
                    ) : (
                      <ChevronRight size={14} className="text-neutral-500 shrink-0" />
                    )}
                    <FolderTree
                      size={14}
                      className={clsx(
                        'shrink-0',
                        isCurrentProject ? 'text-blue-400' : 'text-neutral-500'
                      )}
                    />
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-neutral-200">
                          {projectName}
                        </span>
                        {isCurrentProject && (
                          <span className="rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-400">
                            current
                          </span>
                        )}
                        <span className="text-xs text-neutral-600">
                          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="text-[11px] text-neutral-600 truncate">
                        {projectPath}
                      </div>
                    </div>
                    <div className="text-[10px] text-neutral-600 shrink-0">
                      {formatRelativeTime(latestSession.lastModified)}
                    </div>
                  </button>

                  {/* Sessions in this project */}
                  {isExpanded && (
                    <div className="border-t border-neutral-800/50">
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
  const addSessionTag = useAppStore((state) => state.addSessionTag)
  const removeSessionTag = useAppStore((state) => state.removeSessionTag)
  const allUsedTags = useAppStore((state) => state.allUsedTags)

  const tags = sessionTags[session.sessionId] ?? []
  const [showTagInput, setShowTagInput] = useState(false)
  const [tagInput, setTagInput] = useState('')

  const handleAddTag = async () => {
    if (tagInput.trim()) {
      await addSessionTag(session.sessionId, tagInput.trim())
      setTagInput('')
      setShowTagInput(false)
    }
  }

  return (
    <div
      className={clsx(
        'group px-4 py-2 pl-10 transition-colors',
        isActive
          ? 'bg-blue-900/20'
          : 'hover:bg-neutral-800/30'
      )}
    >
      <button
        onClick={onSelect}
        className="flex w-full items-center gap-3 text-left"
      >
        <Clock size={12} className="shrink-0 text-neutral-600" />
        <div className="min-w-0 flex-1">
          <div className={clsx('text-sm truncate', isActive ? 'text-blue-300' : 'text-neutral-400')}>
            {session.name || session.sessionId.slice(0, 12)}
          </div>
          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
                >
                  <Tag size={8} />
                  {tag}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeSessionTag(session.sessionId, tag)
                    }}
                    className="ml-0.5 hover:text-neutral-200"
                  >
                    <X size={8} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="text-[10px] text-neutral-600 shrink-0">
          {formatRelativeTime(session.lastModified)}
        </div>
        {isActive && (
          <span className="rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-400">
            active
          </span>
        )}
      </button>

      {/* Tag input (shown on hover) */}
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
              className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-300 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <button
              onClick={handleAddTag}
              className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white"
            >
              Add
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowTagInput(true)}
            className="flex items-center gap-1 text-[10px] text-neutral-600 hover:text-neutral-400"
          >
            <Tag size={10} />
            Add tag
          </button>
        )}
      </div>
    </div>
  )
}
