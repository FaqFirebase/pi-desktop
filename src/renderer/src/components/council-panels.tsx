import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useAppStore } from '../store'

const STATUS_LABEL: Record<string, string> = {
  contributed: 'contributed',
  'timed-out': 'timed out',
  errored: 'errored',
}

const AGENT_LABEL: Record<string, string> = {
  pi: 'Pi',
  claude: 'Claude',
  codex: 'Codex',
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function CouncilPanels(): React.JSX.Element | null {
  const run = useAppStore((s) => s.councilRun)
  const approve = useAppStore((s) => s.approveCouncilPlan)
  const revise = useAppStore((s) => s.reviseCouncilPlan)
  const cancel = useAppStore((s) => s.cancelCouncil)
  const isStreaming = useAppStore((s) => s.isStreaming)
  const [reviseText, setReviseText] = React.useState('')

  const consulting = run?.phase === 'consulting'
  const startedAt = run?.startedAt
  const phase = run?.phase
  const [elapsed, setElapsed] = React.useState(0)
  const [collapsed, setCollapsed] = React.useState(false)

  React.useEffect(() => {
    if (!consulting || !startedAt) {
      setElapsed(0)
      return
    }
    const tick = (): void => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [consulting, startedAt])

  // Expand while consultants stream; collapse once a plan is ready so the
  // consensus output below stays readable. The user can still toggle manually.
  React.useEffect(() => {
    if (phase === 'consulting') setCollapsed(false)
    else if (phase === 'awaiting-approval') setCollapsed(true)
  }, [phase])

  if (!run) return null

  const awaiting = run.phase === 'awaiting-approval'

  return (
    <div className="my-2 rounded-lg border border-border-strong bg-surface/60 p-3">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted hover:text-primary"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span>Council planning — {run.phase}</span>
        {consulting && startedAt ? <span className="text-dim">({formatElapsed(elapsed)})</span> : null}
        {collapsed && run.results.length > 0 ? (
          <span className="ml-2 normal-case text-dim">
            {run.results.map((r) => `${AGENT_LABEL[r.id] ?? r.id} ${r.status === 'contributed' ? '✓' : '✕'}`).join(' · ')}
          </span>
        ) : null}
      </button>

      {!collapsed && (
        <div className="mt-2">
          {run.phase === 'refused' && <div className="text-sm text-warning">{run.reason}</div>}

          {/* Live streaming view while consultants are working. */}
          {run.phase === 'consulting' && (run.members?.length ?? 0) > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {run.members!.map((id) => {
                const text = run.partials?.[id] ?? ''
                return (
                  <div key={id} className="rounded border border-border bg-app p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-sm text-primary">{AGENT_LABEL[id] ?? id}</span>
                      <span className="text-xs text-accent-fg">{text ? 'streaming…' : 'working…'}</span>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted">
                      {text}
                    </pre>
                  </div>
                )
              })}
            </div>
          )}

          {run.results.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {run.results.map((r) => (
                <div key={r.id} className="rounded border border-border bg-app p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm text-primary">{AGENT_LABEL[r.id] ?? r.id}</span>
                    <span
                      className={`text-xs ${r.status === 'contributed' ? 'text-success' : 'text-warning'}`}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted">
                    {r.plan ?? r.error ?? ''}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Consensus plan from the read-only arbiter: streamed while merging, then */}
      {/* held here for review. Stays visible even when the consultant cards are  */}
      {/* collapsed, and is never sent to the live session until the user         */}
      {/* approves it below. */}
      {(run.phase === 'merging' || awaiting) && (
        <div className="mt-2 rounded border border-border bg-app p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm text-primary">Consensus plan</span>
            <span className="text-xs text-accent-fg">
              {run.phase === 'merging' ? (run.consensus ? 'merging…' : 'working…') : 'ready for review'}
            </span>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-secondary">
            {run.consensus ?? ''}
          </pre>
        </div>
      )}

      {/* Approval controls stay visible even when the cards are collapsed. */}
      {awaiting && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={reviseText}
              onChange={(e) => setReviseText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && reviseText.trim() && !isStreaming) {
                  void revise(reviseText)
                  setReviseText('')
                }
              }}
              placeholder="Request changes to the plan…"
              disabled={isStreaming}
              className="flex-1 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none disabled:opacity-50"
            />
            <button
              disabled={isStreaming || !reviseText.trim()}
              className="rounded border border-border-strong px-3 py-1 text-sm text-secondary hover:bg-surface-hover disabled:opacity-50"
              onClick={() => {
                void revise(reviseText)
                setReviseText('')
              }}
            >
              Revise
            </button>
          </div>
          <div className="flex justify-end gap-2">
            <button
              className="rounded px-3 py-1 text-sm text-secondary hover:bg-surface-hover"
              onClick={cancel}
            >
              Cancel
            </button>
            <button
              disabled={isStreaming}
              className="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
              onClick={() => void approve()}
            >
              Implement this
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
