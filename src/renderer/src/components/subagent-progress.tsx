import { useAppStore } from '../store'
import { useState, useEffect, useMemo } from 'react'
import { clsx } from 'clsx'
import {
  ChevronDown,
  Loader2,
  Bot,
  CheckCircle2,
  XCircle,
} from 'lucide-react'

/**
 * Compact subagent strip seated on top of the composer pill (parent sets
 * left/right inset). Collapsed: one summary line. Expanded: one line per
 * agent, max 4 then scroll.
 */

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^\x1b]*\x1b\\/g, '')
}

function formatDuration(ms: number): string {
  if (ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

function formatTokens(n: number): string {
  if (n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

type AgentStatus = 'running' | 'done' | 'error'

interface AgentLine {
  id: string
  agent: string
  status: AgentStatus
  task: string
  toolCount: number
  tokens: number
  durationMs: number
  currentTool?: string
}

function normalizeStatus(s: string): AgentStatus {
  if (s === 'done' || s === 'completed') return 'done'
  if (s === 'error' || s === 'failed') return 'error'
  return 'running'
}

function StatusIcon({ status }: { status: AgentStatus }): React.JSX.Element {
  if (status === 'running') {
    return <Loader2 size={11} className="shrink-0 animate-spin text-accent-fg" />
  }
  if (status === 'error') {
    return <XCircle size={11} className="shrink-0 text-error" />
  }
  return <CheckCircle2 size={11} className="shrink-0 text-success" />
}

function AgentRow({ line }: { line: AgentLine }): React.JSX.Element {
  const detail = line.currentTool || line.task
  const stats = [
    line.toolCount > 0 ? `${line.toolCount}t` : '',
    formatTokens(line.tokens),
    formatDuration(line.durationMs),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className={clsx(
        'flex h-7 items-center gap-1.5 px-2.5 text-[11px] leading-none',
        line.status === 'running' && 'bg-accent-bg/10'
      )}
    >
      <StatusIcon status={line.status} />
      <span
        className={clsx(
          'shrink-0 font-medium',
          line.status === 'running' ? 'text-accent-fg' : 'text-secondary'
        )}
      >
        {line.agent}
      </span>
      {detail && (
        <>
          <span className="shrink-0 text-faint">·</span>
          <span
            className={clsx(
              'min-w-0 flex-1 truncate',
              line.currentTool ? 'font-jetbrains text-muted' : 'text-dim'
            )}
            title={detail}
          >
            {detail}
          </span>
        </>
      )}
      {!detail && <span className="min-w-0 flex-1" />}
      {stats && <span className="shrink-0 tabular-nums text-faint">{stats}</span>}
    </div>
  )
}

export function SubagentProgress(): React.JSX.Element | null {
  const subagentProgress = useAppStore((state) => state.subagentProgress)
  const extensionStatuses = useAppStore((state) => state.extensionStatuses)

  // Default collapsed — one summary line. Toggle is fully manual.
  const [expanded, setExpanded] = useState(false)
  const [visible, setVisible] = useState(false)

  const statusLines = useMemo(() => {
    const lines: string[] = []
    for (const key of ['subagent-slash', 'subagent-slash-text', 'subagents-edit']) {
      if (extensionStatuses[key]) lines.push(stripAnsi(extensionStatuses[key]))
    }
    return lines
  }, [extensionStatuses])

  const lines: AgentLine[] = useMemo(() => {
    const out: AgentLine[] = []
    for (const p of subagentProgress) {
      if (p.children && p.children.length > 0) {
        for (const c of p.children) {
          out.push({
            id: c.id,
            agent: c.agent,
            status: normalizeStatus(c.status),
            task: c.task,
            toolCount: c.toolCount,
            tokens: c.tokens,
            durationMs: c.durationMs,
            currentTool: c.currentTool,
          })
        }
      } else {
        out.push({
          id: p.toolCallId,
          agent: p.agent,
          status: normalizeStatus(p.status),
          task: p.task,
          toolCount: p.toolCount,
          tokens: p.tokens,
          durationMs: p.durationMs,
          currentTool: p.currentTool,
        })
      }
    }
    return out
  }, [subagentProgress])

  const hasContent = lines.length > 0 || statusLines.length > 0
  const runningCount = lines.filter((l) => l.status === 'running').length
  const hasRunning = runningCount > 0
  const totalCount = lines.length || statusLines.length

  useEffect(() => {
    if (hasContent) {
      setVisible(true)
    } else {
      const timer = setTimeout(() => {
        setVisible(false)
        setExpanded(false)
      }, 1200)
      return () => clearTimeout(timer)
    }
  }, [hasContent])

  if (!visible || !hasContent) return null

  const ROW_H = 28
  const MAX_ROWS = 4
  const listMaxH = MAX_ROWS * ROW_H

  const summary = hasRunning
    ? `${runningCount} subagent${runningCount === 1 ? '' : 's'} running`
    : `${totalCount} subagent${totalCount === 1 ? '' : 's'} done`

  return (
    // Flush to the pill below: top rounded, bottom square so it reads as a cap.
    <div
      className={clsx(
        'overflow-hidden rounded-t-xl border border-b-0 border-border-strong bg-surface/95 shadow-md shadow-black/20 backdrop-blur-sm',
        hasRunning && 'border-accent-bg/40'
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setExpanded((v) => !v)
        }}
        className="flex h-8 w-full items-center gap-1.5 px-3 text-left text-[11px] transition-colors hover:bg-highlight/40"
        aria-expanded={expanded}
      >
        {hasRunning ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-accent-fg" />
        ) : (
          <Bot size={12} className="shrink-0 text-dim" />
        )}
        <span
          className={clsx(
            'min-w-0 flex-1 truncate font-medium',
            hasRunning ? 'text-primary' : 'text-dim'
          )}
        >
          {summary}
        </span>
        <ChevronDown
          size={12}
          className={clsx(
            'shrink-0 text-faint transition-transform duration-150',
            expanded ? 'rotate-0' : '-rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div
          className="border-t border-border/50"
          style={{
            maxHeight: listMaxH,
            overflowY:
              lines.length > MAX_ROWS || statusLines.length > MAX_ROWS ? 'auto' : 'hidden',
          }}
        >
          {lines.length > 0
            ? lines.map((line) => <AgentRow key={line.id} line={line} />)
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
