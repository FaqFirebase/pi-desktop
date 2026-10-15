import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import type { SubagentTask, SubagentTaskStatus } from '../../../shared/subagent-task'

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000
const TOKENS_PER_K = 1000
const ONE_DECIMAL_TOKEN_LIMIT = 10_000

export function formatSubagentDuration(ms: number): string {
  if (ms <= 0) return ''
  if (ms < MS_PER_SECOND) return `${ms}ms`
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(1)}s`
  return `${Math.floor(ms / MS_PER_MINUTE)}m${Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND)}s`
}

export function formatSubagentTokens(n: number): string {
  if (n <= 0) return ''
  if (n < TOKENS_PER_K) return String(n)
  if (n < ONE_DECIMAL_TOKEN_LIMIT) return `${(n / TOKENS_PER_K).toFixed(1)}k`
  return `${Math.round(n / TOKENS_PER_K)}k`
}

/** Read by screen readers: failed and stopped share an icon and differ only by color. */
const STATUS_LABEL_KEYS = {
  running: 'chat.subagentPanel.status.running',
  done: 'chat.subagentPanel.status.done',
  failed: 'chat.subagentPanel.status.failed',
  stopped: 'chat.subagentPanel.status.stopped',
} as const satisfies Record<SubagentTaskStatus, string>

export function SubagentStatusIcon({ status }: { status: SubagentTaskStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const a11y = { role: 'img', 'aria-label': t(STATUS_LABEL_KEYS[status]), 'aria-hidden': false }
  if (status === 'running') return <Loader2 size={11} className="shrink-0 animate-spin text-accent-fg" {...a11y} />
  if (status === 'failed') return <XCircle size={11} className="shrink-0 text-error" {...a11y} />
  if (status === 'stopped') return <XCircle size={11} className="shrink-0 text-faint" {...a11y} />
  return <CheckCircle2 size={11} className="shrink-0 text-success" {...a11y} />
}

/** One subagent line: status, agent, current tool or label, stats. Clickable when `onSelect` is given. */
export function SubagentTaskRow({
  task,
  onSelect,
}: {
  task: SubagentTask
  onSelect?: (id: string) => void
}): React.JSX.Element {
  const detail = task.currentTool || task.label
  const stats = [
    task.toolCount ? `${task.toolCount}t` : '',
    formatSubagentTokens(task.tokens ?? 0),
    formatSubagentDuration(task.durationMs ?? 0),
  ]
    .filter(Boolean)
    .join(' · ')
  const running = task.status === 'running'
  const className = clsx(
    'flex h-7 w-full items-center gap-1.5 px-2.5 text-left text-[11px] leading-none',
    running && 'bg-accent-bg/10',
    onSelect && 'transition-colors hover:bg-highlight/40'
  )
  const body = (
    <>
      <SubagentStatusIcon status={task.status} />
      <span className={clsx('shrink-0 font-medium', running ? 'text-accent-fg' : 'text-secondary')}>{task.agent}</span>
      {detail ? (
        <>
          <span className="shrink-0 text-faint">·</span>
          <span
            className={clsx('min-w-0 flex-1 truncate', task.currentTool ? 'font-jetbrains text-muted' : 'text-dim')}
            title={detail}
          >
            {detail}
          </span>
        </>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {stats && <span className="shrink-0 tabular-nums text-faint">{stats}</span>}
    </>
  )
  return onSelect ? (
    <button type="button" className={className} onClick={() => onSelect(task.id)}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}
