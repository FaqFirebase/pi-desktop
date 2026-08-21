import { useState, useEffect } from 'react'
import { useAppStore, countPromptsWaitingElsewhere, formatPromptsWaiting } from '../store'
import { clsx } from 'clsx'
import {
  PanelLeft,
  PanelLeftClose,
  Terminal,
  DollarSign,
  Layers,
  Minimize2,
  Settings,
  Loader2,
  GitBranch,
  Workflow as WorkflowIcon,
} from 'lucide-react'

export function StatusBar(): React.JSX.Element {
  const piStatus = useAppStore((state) => state.piStatus)
  const piPid = useAppStore((state) => state.piPid)
  const sessionStats = useAppStore((state) => state.sessionStats)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const pendingSteering = useAppStore((state) => state.pendingSteering)
  const pendingFollowUp = useAppStore((state) => state.pendingFollowUp)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const toggleTerminal = useAppStore((state) => state.toggleTerminal)
  const terminalOpen = useAppStore((state) => state.terminalOpen)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const compactContext = useAppStore((state) => state.compactContext)
  const isCompacting = useAppStore((state) => state.sessionState?.isCompacting ?? false)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const pendingPromptCounts = useAppStore((state) => state.pendingPromptCounts)
  const workflowPanelOpen = useAppStore((state) => state.workflowPanelOpen)
  const workflowRuns = useAppStore((state) => state.workflowRuns)
  const activeWorkflowCount = workflowRuns.filter(
    (run) =>
      (!activeWorkspace || run.workspaceId === activeWorkspace.id) &&
      (run.status === 'running' || run.status === 'paused')
  ).length

  // Blocking prompts held for OTHER workspaces (any extension's select/
  // confirm/input/editor) — the active workspace's prompt is already on screen.
  const promptsWaitingElsewhere = countPromptsWaitingElsewhere(
    pendingPromptCounts,
    activeWorkspace?.id ?? null
  )

  // Current git branch of the active workspace. Refreshed when the workspace
  // changes and when the window regains focus (branch switches outside the app).
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      window.piDesktop.files
        .getGitBranch()
        .then((b) => {
          if (!cancelled) setGitBranch(b)
        })
        .catch(() => {
          if (!cancelled) setGitBranch(null)
        })
    }
    load()
    const onFocus = (): void => load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [activeWorkspace?.id])

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-app px-3 text-xs">
      {/* Left section */}
      <div className="flex items-center gap-3">
        {/* Pi Status */}
        <div className="flex items-center gap-1.5">
          <div
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              piStatus === 'running' && 'bg-success',
              piStatus === 'starting' && 'bg-warning animate-pulse',
              piStatus === 'error' && 'bg-error',
              piStatus === 'stopped' && 'bg-elevated'
            )}
          />
          <span className="text-dim">
            {piStatus === 'running' ? `Pi running (PID: ${piPid})` : `Pi ${piStatus}`}
          </span>
        </div>

        {/* Git branch of the active workspace */}
        {gitBranch && (
          <div className="flex items-center gap-1 text-dim" title={`Git branch: ${gitBranch}`}>
            <GitBranch size={11} />
            <span>{gitBranch}</span>
          </div>
        )}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-1 text-accent-fg">
            <Loader2 size={10} className="animate-spin" />
            <span>streaming</span>
          </div>
        )}

        {/* Queue indicators */}
        {pendingSteering.length > 0 && (
          <span className="text-warning">
            {pendingSteering.length} steer queued
          </span>
        )}
        {pendingFollowUp.length > 0 && (
          <span className="text-warning">
            {pendingFollowUp.length} follow-up queued
          </span>
        )}

        {/* Prompts held for other workspaces (switch back to answer them) */}
        {promptsWaitingElsewhere > 0 && (
          <span
            className="text-warning"
            title="Pi is waiting on a prompt in another workspace; switch to it to answer"
          >
            {formatPromptsWaiting(promptsWaitingElsewhere)}
          </span>
        )}
      </div>

      {/* Right section */}
      <div className="flex items-center gap-3">
        {/* Dedicated workflow navigator */}
        <button
          data-workflow-toggle="true"
          onClick={() => {
            // Session-surface button: opens the active session's runs (scoped by
            // Pi's header UUID, the exact identifier persisted runs carry). The
            // global list is only a fallback for the no-session state; closing
            // preserves the scope so a close/reopen stays in-session.
            const state = useAppStore.getState()
            if (state.workflowPanelOpen) state.setWorkflowPanelOpen(false)
            else if (state.sessionState?.sessionId) state.openWorkflowRunsForSession(state.sessionState.sessionId)
            else state.setWorkflowPanelOpen(true)
          }}
          className={clsx(
            'flex items-center gap-1 transition-colors',
            workflowPanelOpen || activeWorkflowCount > 0 ? 'text-accent-fg' : 'text-dim hover:text-secondary'
          )}
          title="Open workflow runs"
          aria-label="Open workflow runs"
        >
          <WorkflowIcon size={11} />
          <span>{activeWorkflowCount > 0 ? `${activeWorkflowCount} workflow${activeWorkflowCount === 1 ? '' : 's'}` : 'workflows'}</span>
        </button>

        {/* Token usage */}
        {sessionStats?.contextUsage && (
          <div className="flex items-center gap-1 text-dim" title={`Context: ${sessionStats.contextUsage.tokens?.toLocaleString() ?? '?'} / ${sessionStats.contextUsage.contextWindow.toLocaleString()} tokens`}>
            <Layers size={10} />
            <span>
              {Number.isFinite(sessionStats.contextUsage.percent)
                ? `${Math.round(sessionStats.contextUsage.percent as number)}%`
                : '0%'}
            </span>
          </div>
        )}

        {/* Compact context */}
        {sessionStats?.contextUsage && (
          <button
            onClick={() => compactContext()}
            disabled={isCompacting}
            className="flex items-center gap-1 text-dim hover:text-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Compact context — summarize the conversation to free up space"
          >
            {isCompacting ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Minimize2 size={10} />
            )}
            <span>{isCompacting ? 'compacting…' : 'compact'}</span>
          </button>
        )}

        {/* Cost */}
        {sessionStats?.cost !== undefined && sessionStats.cost > 0 && (
          <div className="flex items-center gap-1 text-dim">
            <DollarSign size={10} />
            <span>${sessionStats.cost.toFixed(2)}</span>
          </div>
        )}

        {/* Toggle sidebar */}
        <button
          onClick={toggleSidebar}
          className="rounded p-0.5 text-dim hover:text-secondary transition-colors"
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          {sidebarOpen ? <PanelLeftClose size={12} /> : <PanelLeft size={12} />}
        </button>

        {/* Toggle terminal */}
        <button
          onClick={toggleTerminal}
          className={clsx(
            'rounded p-0.5 transition-colors',
            terminalOpen ? 'text-accent-fg' : 'text-dim hover:text-secondary'
          )}
          title={terminalOpen ? 'Hide terminal' : 'Show terminal'}
          aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
        >
          <Terminal size={12} />
        </button>

        {/* Settings */}
        <button
          onClick={() => setCurrentView('settings')}
          className="rounded p-0.5 text-dim hover:text-secondary transition-colors"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={12} />
        </button>
      </div>
    </div>
  )
}
