import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, Square } from 'lucide-react'
import { turnActivityTimes, useAppStore } from '../store'
import { turnActivity } from '../turn-activity'
import { formatSubagentDuration } from './subagent-task-row'

const TICK_MS = 1_000
const MS_PER_SECOND = 1_000

/** Whole seconds, so the ticking label does not flicker through tenths. */
function wholeSeconds(ms: number): number {
  return Math.floor(ms / MS_PER_SECOND) * MS_PER_SECOND
}

interface TurnActivityLineProps {
  onStop: () => void
}

/**
 * A sign of life while a turn runs: how long it has worked, and a warning
 * with a Stop button once the agent has sent nothing for a while, which is
 * how a stuck model provider looks from here.
 */
export function TurnActivityLine({ onStop }: TurnActivityLineProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const isStreaming = useAppStore((state) => state.isStreaming)
  const toolRunning = useAppStore((state) => [...state.streamingToolCalls.values()].some((call) => call.isExecuting))
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [isStreaming])

  if (!isStreaming) return null
  const activity = turnActivity({ now, ...turnActivityTimes(), toolRunning })
  const elapsed = formatSubagentDuration(wholeSeconds(activity.elapsedMs))

  if (activity.stalled) {
    return (
      <div role="status" className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-warning">
        <AlertTriangle size={12} className="shrink-0" />
        <span className="min-w-0 flex-1">
          {t('chat.activity.stalled', { silent: formatSubagentDuration(wholeSeconds(activity.silentMs)) })}
        </span>
        <button
          type="button"
          onClick={onStop}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-secondary transition-colors hover:bg-highlight-strong"
        >
          <Square size={11} />
          {t('chat.activity.stop')}
        </button>
      </div>
    )
  }

  return (
    <div role="status" className="flex items-center gap-1.5 px-3 pt-1.5 text-xs text-dim">
      <Loader2 size={12} className="shrink-0 animate-spin" />
      <span>{elapsed ? t('chat.activity.workingFor', { elapsed }) : t('chat.activity.working')}</span>
    </div>
  )
}
