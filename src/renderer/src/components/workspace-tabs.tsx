import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Boxes, CheckCircle2, FolderOpen, GitBranch, Loader2, MessageSquarePlus, PanelLeft, Pencil, Plus, Settings, X, XCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import { useGlobalWorkflowOpen } from '../hooks'
import { getSessionTitle } from '../utils/session-title'
import { projectTabs as getProjectTabs, sessionTabs as getSessionTabs } from '../utils/tab-navigation'
import { activeShortcuts } from '../utils/app-shortcuts'
import { formatShortcut } from '../../../shared/keyboard-shortcuts'
import { pathsEqual } from '../../../shared/path-compare'
import { SessionRuntimeIndicator } from './session-runtime-indicator'
import { SessionNameInput } from './session-name-input'
import { useContextMenu } from './context-menu'
import type { Workspace } from '../../../shared/ipc-contracts'

const PROJECT_TAB_DRAG_TYPE = 'application/x-pi-desktop-project-tab'

function tabLabel(workspace: Workspace): string {
  return workspace.name || workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path
}

export function WorkspaceTabs(): React.JSX.Element {
  const { t } = useTranslation()
  const workspaces = useAppStore((state) => state.workspaces)
  const projectTabOrder = useAppStore((state) => state.projectTabOrder)
  const hiddenProjectTabIds = useAppStore((state) => state.hiddenProjectTabIds)
  const reorderProjectTab = useAppStore((state) => state.reorderProjectTab)
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: 'before' | 'after' } | null>(null)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const sessionList = useAppStore((state) => state.sessionList)
  const sessionRuntimes = useAppStore((state) => state.sessionRuntimes)
  const activeSessionRuntimeId = useAppStore((state) => state.activeSessionRuntimeId)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const workspaceActivity = useAppStore((state) => state.workspaceActivity)
  const currentView = useAppStore((state) => state.currentView)
  const globalWorkflowOpen = useGlobalWorkflowOpen()
  const setWorkflowPanelOpen = useAppStore((state) => state.setWorkflowPanelOpen)
  const activateWorkspace = useAppStore((state) => state.activateWorkspace)
  const switchSession = useAppStore((state) => state.switchSession)
  const closeSessionTab = useAppStore((state) => state.closeSessionTab)
  const closeProjectTab = useAppStore((state) => state.closeProjectTab)
  const createWorktreeTab = useAppStore((state) => state.createWorktreeTab)
  const setLinkedTaskDialog = useAppStore((state) => state.setLinkedTaskDialog)
  const createNewSession = useAppStore((state) => state.createNewSession)
  const newSessionShortcut = useAppStore((state) => activeShortcuts(state).newSession)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const sessionState = useAppStore((state) => state.sessionState)
  const setSessionName = useAppStore((state) => state.setSessionName)
  const sessionLoading = useAppStore((state) => state.sessionLoading)
  const { show: showMenu, ContextMenuComponent } = useContextMenu()
  // The rename RPC reaches the runtime main has active, so only that tab
  // renames. A rename left open when another tab becomes active ends unsaved.
  const [renamingRuntimeId, setRenamingRuntimeId] = useState<string | null>(null)
  if (renamingRuntimeId !== null && !sessionRuntimes[renamingRuntimeId]?.active) setRenamingRuntimeId(null)

  const toolView = ['settings', 'packages', 'notes', 'skills', 'diagnostics'] as const
  const toolsActive =
    toolView.includes(currentView as (typeof toolView)[number]) || globalWorkflowOpen

  const tabs = useMemo(
    () => getProjectTabs(workspaces, projectTabOrder, hiddenProjectTabIds),
    [workspaces, projectTabOrder, hiddenProjectTabIds]
  )
  const sessionTabs = useMemo(
    () => getSessionTabs(sessionRuntimes, activeWorkspace?.id),
    [activeWorkspace?.id, sessionRuntimes]
  )

  return (
    <div className="flex shrink-0 flex-col bg-app">
    <div className="flex h-10 items-end gap-1 overflow-x-auto border-b border-border px-2 pt-1">
      {!sidebarOpen && (
        <button
          type="button"
          onClick={toggleSidebar}
          className="mb-1 flex h-7 w-7 shrink-0 animate-fade-in items-center justify-center rounded-md border border-border-strong bg-surface text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
          title={t('common.showSidebar')}
          aria-label={t('common.showSidebar')}
        >
          <PanelLeft size={15} />
        </button>
      )}
      {tabs.map((workspace) => {
        const active = workspace.id === activeWorkspace?.id && !toolsActive
        const activity = workspaceActivity[workspace.id]
        const isWorktree = workspace.kind === 'worktree'
        const isLinkedTask = workspace.kind === 'repoSet'
        const isWorking = activity?.state === 'working'
        const needsApproval = activity?.state === 'needs-approval'
        const completed = activity?.state === 'completed'
        const failed = activity?.state === 'failed'

        return (
          <div
            key={workspace.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(PROJECT_TAB_DRAG_TYPE, workspace.id)
              event.dataTransfer.effectAllowed = 'move'
              setDraggedProjectId(workspace.id)
            }}
            onDragEnd={() => {
              setDraggedProjectId(null)
              setDropTarget(null)
            }}
            onDragOver={(event) => {
              if (!draggedProjectId || !event.dataTransfer.types.includes(PROJECT_TAB_DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const bounds = event.currentTarget.getBoundingClientRect()
              setDropTarget({ id: workspace.id, placement: event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after' })
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
            }}
            onDrop={(event) => {
              if (!draggedProjectId || event.dataTransfer.getData(PROJECT_TAB_DRAG_TYPE) !== draggedProjectId) return
              event.preventDefault()
              event.stopPropagation()
              const bounds = event.currentTarget.getBoundingClientRect()
              reorderProjectTab(draggedProjectId, workspace.id, event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after')
              setDraggedProjectId(null)
              setDropTarget(null)
            }}
            onAuxClick={(event) => {
              // DOM button 1 is the middle mouse button. Keep right-click for
              // the normal context menu and use the middle button as tab-close.
              if (event.button !== 1) return
              event.preventDefault()
              void closeProjectTab(workspace.id)
            }}
            className={clsx(
              'group relative flex h-9 min-w-[150px] max-w-[240px] shrink-0 select-none items-stretch rounded-t-md border border-b-0 text-xs transition-colors',
              draggedProjectId === workspace.id && 'opacity-50',
              active
                ? 'border-border bg-surface text-primary'
                : 'border-transparent text-muted hover:bg-surface/60 hover:text-secondary'
            )}
          >
            {dropTarget?.id === workspace.id && draggedProjectId !== workspace.id && (
              <span aria-hidden="true" className={clsx(
                'pointer-events-none absolute inset-y-0 w-0.5 rounded bg-accent-fg',
                dropTarget.placement === 'before' ? 'left-0' : 'right-0'
              )} />
            )}
            <button
              type="button"
              onClick={() => {
                setWorkflowPanelOpen(false)
                if (workspace.id === activeWorkspace?.id) {
                  setCurrentView('chat')
                  return
                }
                void activateWorkspace(workspace.id).then((switched) => {
                  if (switched) setCurrentView('chat')
                })
              }}
              // The select button fills the whole tab; the close button sits on top of it.
              className={clsx('flex min-w-0 flex-1 items-center gap-2 pl-2.5 text-left', tabs.length > 1 ? 'pr-8' : 'pr-2.5')}
              title={`${workspace.path}${workspace.branch ? `\n${workspace.branch}` : ''}`}
            >
              {isLinkedTask ? (
                <Boxes size={13} className="shrink-0 text-special" />
              ) : isWorktree ? (
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
                onClick={() => void closeProjectTab(workspace.id)}
                draggable
                onDragStart={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                className="absolute right-2.5 top-1/2 shrink-0 -translate-y-1/2 rounded p-0.5 text-faint opacity-0 transition-all hover:bg-highlight hover:text-primary group-hover:opacity-100"
                title={t('store.confirm.closeTabLabel')}
                aria-label={t('workspaceTabs.closeTabAriaLabel', { name: tabLabel(workspace) })}
              >
                <X size={12} />
              </button>
            )}
          </div>
        )
      })}

      {toolsActive && (
        <div className="group flex h-9 min-w-[140px] shrink-0 items-center rounded-t-md border border-b-0 border-border bg-surface text-primary">
          {/* The tab only exists while a tool surface is on screen, so its label
              always names what is already showing — a static marker, never a
              control that navigates somewhere the user did not ask for. Closing
              is the neighbouring button's job. */}
          <div
            aria-current="page"
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-xs"
            title={t('workspaceTabs.tools')}
          >
            <Settings size={13} className="shrink-0 text-accent-fg" />
            <span className="truncate font-medium">{t('workspaceTabs.tools')}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setWorkflowPanelOpen(false)
              setCurrentView('chat')
            }}
            className="mr-1 rounded p-1 text-faint opacity-0 transition-all hover:bg-highlight hover:text-primary group-hover:opacity-100"
            title={t('workspaceTabs.closeTools')}
            aria-label={t('workspaceTabs.closeTools')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => void createWorktreeTab()}
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary transition-colors"
        title={t('workspaceTabs.newIsolatedTabTitle')}
        aria-label={t('workspaceTabs.newIsolatedTabAriaLabel')}
      >
        <Plus size={15} />
      </button>
      <button
        type="button"
        onClick={() => setLinkedTaskDialog({ view: 'start' })}
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary transition-colors"
        title={t('workspaceTabs.newLinkedTaskTitle')}
        aria-label={t('workspaceTabs.newLinkedTaskAriaLabel')}
      >
        <Boxes size={15} />
      </button>
    </div>
    {/* The row shows for every open project, even before its first session,
        so the new session button always has a home. */}
    {activeWorkspace && (
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 px-2">
        <span className="mr-1 shrink-0 text-[10px] uppercase tracking-wide text-faint">{t('workspaceTabs.sessions')}</span>
        {sessionTabs.map((runtime) => {
          const session = sessionList.find((item) => runtime.sessionPath && pathsEqual(item.path, runtime.sessionPath))
          const active = runtime.runtimeId === activeSessionRuntimeId || runtime.active
          // The chat already shows this tab's session.
          const shown = Boolean(sessionState?.sessionFile && runtime.sessionPath && pathsEqual(sessionState.sessionFile, runtime.sessionPath))
          // A session gets its list row only once its file has content; until
          // then its name comes from the chat state (the shown session) or
          // from the runtime (a rename made while it was shown).
          const liveName = shown ? sessionState?.sessionName?.trim() || null : null
          const name = liveName || session?.name?.trim() || runtime.sessionName || null
          const title = session
            ? getSessionTitle(name, session.sessionId, session.preview)
            : name || t('workspaceTabs.newSessionFallback')
          if (renamingRuntimeId === runtime.runtimeId) {
            return (
              <div
                key={runtime.runtimeId}
                className="flex min-w-0 max-w-[240px] shrink-0 items-center gap-1.5 rounded bg-card py-0.5 pl-2 pr-1 text-[11px] text-primary"
              >
                <SessionRuntimeIndicator runtime={runtime} />
                <SessionNameInput
                  initialName={name ?? ''}
                  onDone={(newName) => {
                    setRenamingRuntimeId(null)
                    if (newName) void setSessionName(newName)
                  }}
                  className="w-40 px-1.5 py-0.5"
                />
              </div>
            )
          }
          return (
            <div
              key={runtime.runtimeId}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                void closeSessionTab(runtime.runtimeId)
              }}
              onContextMenu={(event) => {
                // The document-level handler would show the default menu on top.
                event.nativeEvent.stopPropagation()
                showMenu(event, [
                  ...(runtime.active
                    ? [{
                        id: 'session-tab-rename',
                        label: t('contextMenu.rename'),
                        icon: <Pencil size={14} />,
                        action: () => setRenamingRuntimeId(runtime.runtimeId),
                      }]
                    : []),
                  {
                    id: 'session-tab-close',
                    label: t('workspaceTabs.closeSessionTab'),
                    icon: <X size={14} />,
                    action: () => void closeSessionTab(runtime.runtimeId),
                  },
                ])
              }}
              className={clsx(
                'group relative flex min-w-0 max-w-[240px] shrink-0 items-stretch rounded text-[11px] transition-colors',
                active ? 'bg-card text-primary' : 'text-muted hover:bg-highlight hover:text-secondary'
              )}
            >
              <button
                type="button"
                onClick={() => {
                  if (!runtime.sessionPath) return
                  setCurrentView('chat')
                  // switchSession reloads a session with no messages yet, and
                  // the reload then focuses the composer, which would end a
                  // rename the second click of a double-click just opened.
                  if (shown && !sessionLoading) return
                  void switchSession(runtime.sessionPath, activeWorkspace?.path)
                }}
                onDoubleClick={() => {
                  if (runtime.active) setRenamingRuntimeId(runtime.runtimeId)
                }}
                // The select button fills the whole tab; the close button sits on top of it.
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 pr-6 text-left"
                title={runtime.active ? t('workspaceTabs.sessionTabTitleRenamable', { path: runtime.sessionPath ?? '' }) : runtime.sessionPath ?? undefined}
                aria-current={active ? 'page' : undefined}
              >
                <SessionRuntimeIndicator runtime={runtime} />
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                onClick={() => void closeSessionTab(runtime.runtimeId)}
                className="absolute right-1 top-1/2 shrink-0 -translate-y-1/2 rounded p-0.5 text-faint opacity-0 transition-all hover:bg-highlight-strong hover:text-primary group-hover:opacity-100"
                title={t('workspaceTabs.closeSessionTab')}
                aria-label={t('workspaceTabs.closeSessionTab')}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          onClick={() => {
            setWorkflowPanelOpen(false)
            setCurrentView('chat')
            void createNewSession()
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-highlight hover:text-primary"
          title={newSessionShortcut
            ? t('settings.shortcuts.actionWithShortcut', { action: t('workspaceTabs.newSessionAriaLabel'), shortcut: formatShortcut(newSessionShortcut, window.piDesktop.system.platform) })
            : t('workspaceTabs.newSessionAriaLabel')}
          aria-label={t('workspaceTabs.newSessionAriaLabel')}
        >
          <MessageSquarePlus size={13} />
        </button>
      </div>
    )}
    {ContextMenuComponent}
    </div>
  )
}
