import { useAppStore } from '../store'
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { stripAnsi } from '../utils/strip-ansi'
import { ChevronDown, Loader2, Bot } from 'lucide-react'
import { countRunningSubagentTasks, stripSubagentTasks } from '../../../shared/subagent-task'
import { SubagentTaskRow } from './subagent-task-row'

/**
 * Compact subagent strip seated on top of the composer pill (parent sets
 * left/right inset). Collapsed: one summary line that opens the Tasks panel.
 * Expanded: one line per agent, max 4 then scroll.
 *
 * Rows stay in the store for the whole chat (the Tasks panel lists them), but
 * the strip shows only running rows and the rows the live turn spawned.
 */

const STATUS_KEYS = ['subagent-slash', 'subagent-slash-text', 'subagents-edit'] as const
const HIDE_DELAY_MS = 1200
const ROW_HEIGHT_PX = 28
const MAX_VISIBLE_ROWS = 4

export function SubagentProgress(): React.JSX.Element | null {
  const { t } = useTranslation()
  const allTasks = useAppStore((state) => state.subagentTasks)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const extensionStatuses = useAppStore((state) => state.extensionStatuses)

  // Default collapsed — one summary line. Toggle is fully manual.
  const [expanded, setExpanded] = useState(false)
  const [visible, setVisible] = useState(false)
  // Row ids the chat had when the current turn began. Updated during render
  // (not in an effect), so the first frame of a turn never counts old rows.
  const [knownAtTurnStart, setKnownAtTurnStart] = useState<ReadonlySet<string>>(() => new Set())
  const [wasStreaming, setWasStreaming] = useState(isStreaming)
  if (isStreaming !== wasStreaming) {
    setWasStreaming(isStreaming)
    if (isStreaming) setKnownAtTurnStart(new Set(allTasks.map((task) => task.id)))
  }

  const statusLines = useMemo(() => {
    const lines: string[] = []
    for (const key of STATUS_KEYS) {
      if (extensionStatuses[key]) lines.push(stripAnsi(extensionStatuses[key]))
    }
    return lines
  }, [extensionStatuses])

  const tasks = useMemo(() => stripSubagentTasks(allTasks, knownAtTurnStart), [allTasks, knownAtTurnStart])
  const runningCount = countRunningSubagentTasks(tasks)
  const hasRunning = runningCount > 0
  const hasContent = hasRunning || (isStreaming && tasks.length > 0) || statusLines.length > 0
  const totalCount = tasks.length || statusLines.length

  useEffect(() => {
    if (hasContent) {
      setVisible(true)
      return
    }
    const timer = setTimeout(() => {
      setVisible(false)
      setExpanded(false)
    }, HIDE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hasContent])

  if (!visible || totalCount === 0) return null

  const summary = hasRunning
    ? t('chat.subagentProgress.running', { count: runningCount })
    : t('chat.subagentProgress.done', { count: totalCount })
  const scrolls = tasks.length > MAX_VISIBLE_ROWS || statusLines.length > MAX_VISIBLE_ROWS

  return (
    // Flush to the pill below: top rounded, bottom square so it reads as a cap.
    <div
      className={clsx(
        'overflow-hidden rounded-t-xl border border-b-0 border-border-strong bg-surface/95 shadow-md shadow-black/20 backdrop-blur-sm',
        hasRunning && 'border-accent-bg/40'
      )}
    >
      <div className="flex h-8 w-full items-center text-[11px]">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void useAppStore.getState().setChatSidePanel('tasks')
          }}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 text-left transition-colors hover:bg-highlight/40"
          title={t('chat.subagentProgress.openPanel')}
        >
          {hasRunning ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-accent-fg" />
          ) : (
            <Bot size={12} className="shrink-0 text-dim" />
          )}
          <span className={clsx('min-w-0 flex-1 truncate font-medium', hasRunning ? 'text-primary' : 'text-dim')}>
            {summary}
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          className="flex h-full items-center px-3 transition-colors hover:bg-highlight/40"
          aria-expanded={expanded}
          aria-label={summary}
        >
          <ChevronDown
            size={12}
            className={clsx('shrink-0 text-faint transition-transform duration-150', expanded ? 'rotate-0' : '-rotate-90')}
          />
        </button>
      </div>

      {expanded && (
        <div
          className="border-t border-border/50"
          style={{ maxHeight: MAX_VISIBLE_ROWS * ROW_HEIGHT_PX, overflowY: scrolls ? 'auto' : 'hidden' }}
        >
          {tasks.length > 0
            ? tasks.map((task) => <SubagentTaskRow key={task.id} task={task} />)
            : statusLines.map((status, i) => (
                <div
                  key={i}
                  className="flex h-7 items-center truncate px-3 font-jetbrains text-[11px] text-muted"
                  title={status}
                >
                  {status}
                </div>
              ))}
        </div>
      )}
    </div>
  )
}
