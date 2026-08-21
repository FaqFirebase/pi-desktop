import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowUpRight, CheckCircle2, Circle, Inbox, Loader2, Play, RefreshCw, XCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import { getSessionTitle } from '../utils/session-title'
import { pathsEqual } from '../../../shared/path-compare'
import { canResumeRun } from '../utils/workflow-runs'
import { SessionRuntimeIndicator } from './session-runtime-indicator'
import type { SessionRuntimeInfo, WorkflowRunSummary } from '../../../shared/ipc-contracts'

export function MissionControl(): React.JSX.Element {
  const workspaces = useAppStore((state) => state.workspaces)
  const sessionList = useAppStore((state) => state.sessionList)
  const sessionRuntimes = useAppStore((state) => state.sessionRuntimes)
  const workflowRuns = useAppStore((state) => state.workflowRuns)
  const refreshWorkflowRuns = useAppStore((state) => state.refreshWorkflowRuns)
  const openSessionItem = useAppStore((state) => state.openSessionItem)
  const activateWorkspace = useAppStore((state) => state.activateWorkspace)
  const switchSession = useAppStore((state) => state.switchSession)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const setTaskLauncherOpen = useAppStore((state) => state.setTaskLauncherOpen)
  const openWorkflowRunsForWorkspace = useAppStore((state) => state.openWorkflowRunsForWorkspace)
  const [controlBusy, setControlBusy] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)

  useEffect(() => {
    void refreshWorkflowRuns()
    const timer = window.setInterval(() => void refreshWorkflowRuns(), 5000)
    return () => window.clearInterval(timer)
  }, [refreshWorkflowRuns])

  const runtimes = useMemo(
    () => Object.values(sessionRuntimes)
      .filter((runtime) => runtime.status !== 'stopped' || runtime.activity !== null)
      .sort((a, b) => Number(b.active) - Number(a.active)),
    [sessionRuntimes]
  )
  const recentRuns = useMemo(
    () => [...workflowRuns].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 8),
    [workflowRuns]
  )
  const attentionCount = runtimes.filter((runtime) => runtime.activity === 'needs-approval' || runtime.activity === 'failed' || runtime.status === 'error').length +
    workflowRuns.filter((run) => run.status === 'paused' || run.status === 'failed').length

  const resumeRun = async (run: WorkflowRunSummary): Promise<void> => {
    if (controlBusy) return
    setControlBusy(run.runId)
    setControlError(null)
    try {
      const result = await window.piDesktop.workflows.control(run.workspaceId, run.runId, 'resume')
      if (!result.ok) setControlError(`Could not proceed with ${run.workflowName}: ${result.reason ?? 'control unavailable'}`)
      else await refreshWorkflowRuns()
    } catch {
      setControlError(`Could not proceed with ${run.workflowName}. Open the run for details.`)
    } finally {
      setControlBusy(null)
    }
  }

  const openRuntime = async (runtime: SessionRuntimeInfo): Promise<void> => {
    if (!runtime.sessionPath) return
    const workspace = workspaces.find((item) => item.id === runtime.workspaceId)
    if (!workspace) return
    const session = sessionList.find((item) => pathsEqual(item.path, runtime.sessionPath!))
    if (session) {
      await openSessionItem(session)
    } else {
      if (!(await activateWorkspace(workspace.id, { awaitingSession: true }))) return
      await switchSession(runtime.sessionPath, workspace.path)
      setCurrentView('chat')
    }
  }

  const reviewRuntime = async (runtime: SessionRuntimeInfo): Promise<void> => {
    await openRuntime(runtime)
    if (useAppStore.getState().activeSessionRuntimeId === runtime.runtimeId) setCurrentView('diff')
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-7">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Inbox size={19} className="text-accent-fg" />
              <h1 className="text-lg font-semibold text-primary">Mission Control</h1>
              {attentionCount > 0 && (
                <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[10px] font-medium text-warning">
                  {attentionCount} needs attention
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-dim">Background sessions and workflow runs, from every project.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshWorkflowRuns()}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
              title="Refresh workflow runs"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setTaskLauncherOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <Play size={12} />
              New task
            </button>
          </div>
        </div>

        <section className="mb-6">
          <SectionHeading title="Live sessions" count={runtimes.length} />
          {runtimes.length === 0 ? (
            <EmptyState>No live session runtimes yet. Start a task to put Pi to work in the background.</EmptyState>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {runtimes.map((runtime) => {
                const workspace = workspaces.find((item) => item.id === runtime.workspaceId)
                const session = runtime.sessionPath
                  ? sessionList.find((item) => pathsEqual(item.path, runtime.sessionPath!))
                  : undefined
                const title = session
                  ? getSessionTitle(session.name, session.sessionId, session.preview)
                  : runtime.sessionId ?? 'Starting session'
                const canOpen = !!runtime.sessionPath && !!workspace
                return (
                  <div key={runtime.runtimeId} className="flex items-center gap-3 rounded-lg border border-border bg-surface/50 px-3 py-3">
                    <SessionRuntimeIndicator runtime={runtime} />
                    {!runtime.activity && runtime.status === 'running' && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-success" title="Pi is idle" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-primary">{title}</div>
                      <div className="truncate text-[11px] text-faint">{workspace?.name ?? 'Unknown project'} · {runtimeState(runtime)}</div>
                    </div>
                    {canOpen && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void openRuntime(runtime)}
                          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted transition-colors hover:bg-highlight hover:text-primary"
                        >
                          Open <ArrowUpRight size={11} />
                        </button>
                        {(runtime.activity === 'completed' || workspace?.kind === 'worktree') && (
                          <button
                            type="button"
                            onClick={() => void reviewRuntime(runtime)}
                            className="rounded border border-accent/40 px-2 py-1 text-[10px] text-accent-fg transition-colors hover:bg-accent-bg/20"
                          >
                            Review
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionHeading title="Workflow activity" count={workflowRuns.length} />
            <button
              type="button"
              onClick={() => openWorkflowRunsForWorkspace(null)}
              className="text-[11px] text-muted transition-colors hover:text-accent-fg"
            >
              Open all workflows
            </button>
          </div>
          {recentRuns.length === 0 ? (
            <EmptyState>No workflow runs yet.</EmptyState>
          ) : (
            <>
              {controlError && <div className="mb-2 rounded border border-error/40 bg-error-bg/20 px-3 py-2 text-[11px] text-error" role="status">{controlError}</div>}
              <div className="space-y-2">
              {recentRuns.map((run) => (
                <WorkflowRow
                  key={`${run.workspaceId}:${run.runId}`}
                  run={run}
                  onOpen={() => openWorkflowRunsForWorkspace(run.workspaceId)}
                  onResume={() => void resumeRun(run)}
                  resumeBusy={controlBusy === run.runId}
                />
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function WorkflowRow({
  run,
  onOpen,
  onResume,
  resumeBusy,
}: {
  run: WorkflowRunSummary
  onOpen: () => void
  onResume: () => void
  resumeBusy: boolean
}): React.JSX.Element {
  const Icon = run.status === 'completed'
    ? CheckCircle2
    : run.status === 'failed' || run.status === 'aborted'
      ? XCircle
      : run.status === 'paused'
        ? AlertCircle
        : run.status === 'unknown'
          ? Circle
          : Loader2
  const iconClass = run.status === 'running' || run.status === 'pending'
    ? 'animate-spin text-accent-fg'
    : run.status === 'completed'
      ? 'text-success'
      : run.status === 'paused'
        ? 'text-warning'
        : run.status === 'unknown'
          ? 'text-muted'
          : 'text-error'
  return (
    <div className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface/50 px-3 py-2 transition-colors hover:border-border-strong hover:bg-surface-hover">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-1 text-left">
        <Icon size={14} className={clsx('shrink-0', iconClass)} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-primary">{run.workflowName}</div>
          <div className="truncate text-[11px] text-faint">{run.workspaceName} · {run.currentPhase ?? run.status}</div>
        </div>
        <span className="shrink-0 text-[11px] capitalize text-muted">{run.status}</span>
      </button>
      {canResumeRun(run.status) && (
        <button
          type="button"
          onClick={onResume}
          disabled={resumeBusy}
          className="flex shrink-0 items-center gap-1 rounded border border-success/40 px-2 py-1 text-[10px] font-medium text-success transition-colors hover:bg-success-bg/20 disabled:cursor-not-allowed disabled:opacity-50"
          title={run.status === 'paused' ? 'Proceed with this workflow' : 'Retry this workflow'}
        >
          {resumeBusy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          {run.status === 'paused' ? 'Proceed' : 'Retry'}
        </button>
      )}
    </div>
  )
}

function SectionHeading({ title, count }: { title: string; count: number }): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-dim">
      <span>{title}</span>
      <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] font-normal text-faint">{count}</span>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-faint">{children}</div>
}

function runtimeState(runtime: SessionRuntimeInfo): string {
  if (runtime.activity === 'needs-approval') return 'needs approval'
  if (runtime.activity === 'working' || runtime.status === 'starting') return 'working'
  if (runtime.activity === 'failed' || runtime.status === 'error') return 'failed'
  if (runtime.activity === 'completed') return 'completed'
  return runtime.status === 'running' ? 'idle' : runtime.status
}
