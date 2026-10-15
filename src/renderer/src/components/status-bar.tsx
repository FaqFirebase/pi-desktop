import { useTranslation } from 'react-i18next'
import { useAppStore, countPromptsWaitingElsewhere, formatPromptsWaiting } from '../store'
import { agentEngineLabel } from '../../../shared/agent-engine-label'
import { clsx } from 'clsx'
import { ProjectBranchSelector } from './project-branch-selector'
import {
  PanelLeft,
  Terminal,
  DollarSign,
  Layers,
  Minimize2,
  Settings,
  Loader2,
  Workflow as WorkflowIcon,
} from 'lucide-react'

export function StatusBar(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const piStatus = useAppStore((state) => state.piStatus)
  const piPid = useAppStore((state) => state.piPid)
  // Name the engine that is actually running; the two are not interchangeable
  // and a user who switched to OMP should not be told Pi is running.
  const engineLabel = useAppStore((state) => agentEngineLabel(state.piEngine) ?? 'Pi')
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
            {piStatus === 'running'
              ? t('statusBar.piRunning', { agent: engineLabel, pid: piPid })
              : piStatus === 'starting'
                ? t('statusBar.piStarting', { agent: engineLabel })
                : piStatus === 'error'
                  ? t('statusBar.piError', { agent: engineLabel })
                  : t('statusBar.piStopped', { agent: engineLabel })}
          </span>
        </div>

        {/* Git branch of the active workspace */}
        {activeWorkspace && <ProjectBranchSelector key={activeWorkspace.id} workspaceId={activeWorkspace.id} />}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-1 text-accent-fg">
            <Loader2 size={10} className="animate-spin" />
            <span>{t('statusBar.streaming')}</span>
          </div>
        )}

        {/* Queue indicators */}
        {pendingSteering.length > 0 && (
          <span className="text-warning">
            {t('statusBar.steerQueued', { count: pendingSteering.length })}
          </span>
        )}
        {pendingFollowUp.length > 0 && (
          <span className="text-warning">
            {t('statusBar.followUpQueued', { count: pendingFollowUp.length })}
          </span>
        )}

        {/* Prompts held for other workspaces (switch back to answer them) */}
        {promptsWaitingElsewhere > 0 && (
          <span
            className="text-warning"
            title={t('statusBar.waitingOnPromptElsewhere', { agent: engineLabel })}
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
          title={t('statusBar.openWorkflowRuns')}
          aria-label={t('statusBar.openWorkflowRuns')}
        >
          <WorkflowIcon size={11} />
          <span>
            {activeWorkflowCount > 0
              ? t('statusBar.workflowCount', { count: activeWorkflowCount })
              : t('statusBar.workflowsFallback')}
          </span>
        </button>

        {/* Token usage */}
        {sessionStats?.contextUsage && (
          <div
            className="flex items-center gap-1 text-dim"
            title={t('statusBar.contextUsage', {
              tokens: sessionStats.contextUsage.tokens?.toLocaleString(i18n.language) ?? '?',
              contextWindow: sessionStats.contextUsage.contextWindow.toLocaleString(i18n.language),
            })}
          >
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
            title={t('statusBar.compactContextTitle')}
          >
            {isCompacting ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Minimize2 size={10} />
            )}
            <span>{isCompacting ? t('statusBar.compacting') : t('statusBar.compact')}</span>
          </button>
        )}

        {/* Cost */}
        {sessionStats?.cost !== undefined && sessionStats.cost > 0 && (
          <div className="flex items-center gap-1 text-dim">
            <DollarSign size={10} />
            <span>${sessionStats.cost.toFixed(2)}</span>
          </div>
        )}

        {!sidebarOpen && (
          <button
            onClick={toggleSidebar}
            className="rounded p-0.5 text-dim hover:text-secondary transition-colors"
            title={t('common.showSidebar')}
            aria-label={t('common.showSidebar')}
          >
            <PanelLeft size={12} />
          </button>
        )}

        {/* Toggle terminal */}
        <button
          onClick={toggleTerminal}
          className={clsx(
            'rounded p-0.5 transition-colors',
            terminalOpen ? 'text-accent-fg' : 'text-dim hover:text-secondary'
          )}
          title={terminalOpen ? t('statusBar.hideTerminal') : t('statusBar.showTerminal')}
          aria-label={terminalOpen ? t('statusBar.hideTerminal') : t('statusBar.showTerminal')}
        >
          <Terminal size={12} />
        </button>

        {/* Settings */}
        <button
          onClick={() => setCurrentView('settings')}
          className="rounded p-0.5 text-dim hover:text-secondary transition-colors"
          title={t('common.settings')}
          aria-label={t('common.settings')}
        >
          <Settings size={12} />
        </button>
      </div>
    </div>
  )
}
