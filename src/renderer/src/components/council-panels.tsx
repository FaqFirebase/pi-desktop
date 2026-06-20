import React from 'react'
import { useAppStore } from '../store'

const STATUS_LABEL: Record<string, string> = {
  contributed: 'contributed',
  'timed-out': 'timed out',
  errored: 'errored',
}

const AGENT_LABEL: Record<string, string> = {
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
  const cancel = useAppStore((s) => s.cancelCouncil)

  const consulting = run?.phase === 'consulting'
  const startedAt = run?.startedAt
  const [elapsed, setElapsed] = React.useState(0)
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

  if (!run) return null

  return (
    <div className="my-2 rounded-lg border border-neutral-700 bg-neutral-900/60 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
        Council planning — {run.phase}
        {consulting && startedAt ? <span className="ml-1 text-neutral-500">({formatElapsed(elapsed)})</span> : null}
      </div>

      {run.phase === 'refused' && <div className="text-sm text-amber-400">{run.reason}</div>}

      {/* Live streaming view while consultants are working. */}
      {run.phase === 'consulting' && (run.members?.length ?? 0) > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {run.members!.map((id) => {
            const text = run.partials?.[id] ?? ''
            return (
              <div key={id} className="rounded border border-neutral-800 bg-neutral-950 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm text-neutral-200">{AGENT_LABEL[id] ?? id}</span>
                  <span className="text-xs text-blue-400">{text ? 'streaming…' : 'working…'}</span>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-neutral-400">
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
            <div key={r.id} className="rounded border border-neutral-800 bg-neutral-950 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm text-neutral-200">{AGENT_LABEL[r.id] ?? r.id}</span>
                <span
                  className={`text-xs ${r.status === 'contributed' ? 'text-green-400' : 'text-amber-400'}`}
                >
                  {STATUS_LABEL[r.status]}
                </span>
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-neutral-400">
                {r.plan ?? r.error ?? ''}
              </pre>
            </div>
          ))}
        </div>
      )}

      {run.phase === 'awaiting-approval' && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            className="rounded px-3 py-1 text-sm text-neutral-300 hover:bg-neutral-800"
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500"
            onClick={() => void approve()}
          >
            Implement this
          </button>
        </div>
      )}
    </div>
  )
}
