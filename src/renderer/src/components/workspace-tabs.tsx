import { useMemo } from 'react'
import { AlertCircle, CheckCircle2, FolderOpen, GitBranch, Loader2, MessageSquarePlus, PanelLeft, Plus, Settings, X, XCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import type { Workspace } from '../../../shared/ipc-contracts'

function tabLabel(workspace: Workspace): string {
  return workspace.name || workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path
}

export function WorkspaceTabs(): React.JSX.Element {
  const workspaces = useAppStore((state) => state.workspaces)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const workspaceActivity = useAppStore((state) => state.workspaceActivity)
  const currentView = useAppStore((state) => state.currentView)
  const workflowPanelOpen = useAppStore((state) => state.workflowPanelOpen)
  const workflowPanelFilter = useAppStore((state) => state.workflowPanelFilter)
  const workflowPanelWorkspaceId = useAppStore((state) => state.workflowPanelWorkspaceId)
  const setWorkflowPanelOpen = useAppStore((state) => state.setWorkflowPanelOpen)
  const switchWorkspace = useAppStore((state) => state.switchWorkspace)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const createWorktreeTab = useAppStore((state) => state.createWorktreeTab)
  const createNewSession = useAppStore((state) => state.createNewSession)
  const setCurrentView = useAppStore((state) => state.setCurrentView)

  const toolView = ['settings', 'packages', 'notes', 'skills', 'diagnostics'] as const
  const toolsActive =
    toolView.includes(currentView as (typeof toolView)[number]) ||
    (workflowPanelOpen && !workflowPanelFilter && workflowPanelWorkspaceId === null)

  const tabs = useMemo(
    () => [...workspaces].sort((a, b) => a.createdAt - b.createdAt),
    [workspaces]
  )

  return (
    <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-app px-2 pt-1">
      {!sidebarOpen && (
        <button
          type="button"
          onClick={toggleSidebar}
          className="mb-1 flex h-7 w-7 shrink-0 animate-fade-in items-center justify-center rounded-md border border-border-strong bg-surface text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <PanelLeft size={15} />
        </button>
      )}
      {tabs.map((workspace) => {
        const active = workspace.id === activeWorkspace?.id && !toolsActive
        const activity = workspaceActivity[workspace.id]
        const isWorktree = workspace.kind === 'worktree'
        const isWorking = activity?.state === 'working'
        const needsApproval = activity?.state === 'needs-approval'
        const completed = activity?.state === 'completed'
        const failed = activity?.state === 'failed'

        return (
          <div
            key={workspace.id}
            className={clsx(
              'group flex h-9 min-w-[150px] max-w-[240px] shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-2.5 text-xs transition-colors',
              active
                ? 'border-border bg-surface text-primary'
                : 'border-transparent text-muted hover:bg-surface/60 hover:text-secondary'
            )}
          >
            <button
              type="button"
              onClick={() => {
                setWorkflowPanelOpen(false)
                if (workspace.id === activeWorkspace?.id) {
                  setCurrentView('chat')
                  return
                }
                void switchWorkspace(workspace.id).then((switched) => {
                  if (switched) setCurrentView('chat')
                })
              }}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={`${workspace.path}${workspace.branch ? `\n${workspace.branch}` : ''}`}
            >
              {isWorktree ? (
                <GitBranch size={13} className="shrink-0 text-special" />
              ) : (
                <FolderOpen size={13} className="shrink-0 text-dim" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{tabLabel(workspace)}</span>
              {isWorking && <Loader2 size={12} className="shrink-0 animate-spin text-accent-fg" />}
              {needsApproval && <AlertCircle size={12} className="shrink-0 text-warning" />}
              {completed && <CheckCircle2 size={12} className="shrink-0 text-success" />}
              {failed && <XCircle size={12} className="shrink-0 text-error" />}
            </button>
            {tabs.length > 1 && (
              <button
                type="button"
                onClick={() => void removeWorkspace(workspace.id)}
                className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-all hover:bg-highlight hover:text-primary group-hover:opacity-100"
                title={isWorktree ? 'Close tab' : 'Remove workspace'}
                aria-label={isWorktree ? `Close ${tabLabel(workspace)}` : `Remove ${tabLabel(workspace)}`}
              >
                <X size={12} />
              </button>
            )}
          </div>
        )
      })}

      {toolsActive && (
        <button
          type="button"
          aria-current="page"
          onClick={() => {
            if (!toolView.includes(currentView as (typeof toolView)[number])) {
              setWorkflowPanelOpen(false)
              setCurrentView('settings')
            }
          }}
          className="group flex h-9 min-w-[110px] shrink-0 items-center gap-2 rounded-t-md border border-b-0 border-border bg-surface px-2.5 text-left text-xs text-primary"
          title="Tools"
        >
          <Settings size={13} className="shrink-0 text-accent-fg" />
          <span className="truncate font-medium">Tools</span>
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          setWorkflowPanelOpen(false)
          setCurrentView('chat')
          void createNewSession()
        }}
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary transition-colors"
        title="New session in this project (Ctrl/Cmd+N)"
        aria-label="New session in this project"
      >
        <MessageSquarePlus size={15} />
      </button>
      <button
        type="button"
        onClick={() => void createWorktreeTab()}
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary transition-colors"
        title="New isolated Git tab (requires a Git project)"
        aria-label="New isolated Git tab"
      >
        <Plus size={15} />
      </button>
    </div>
  )
}
