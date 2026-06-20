import { useEffect } from 'react'
import { useAppStore } from '../store'
import type { TimelineEvent as StoreTimelineEvent } from '../../../shared/ipc-contracts'
import { clsx } from 'clsx'
import {
  Activity,
  MessageSquare,
  Wrench,
  Brain,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Trash2,
  Clock,
  GitFork,
  GitBranch,
  Copy,
} from 'lucide-react'
import type { LineageNode } from '../../../shared/session-lineage'

export function Timeline(): React.JSX.Element {
  const timelineEvents = useAppStore((state) => state.timelineEvents)
  const clearTimeline = useAppStore((state) => state.clearTimeline)
  const forkMessages = useAppStore((state) => state.forkMessages)
  const loadForkMessages = useAppStore((state) => state.loadForkMessages)
  const forkFrom = useAppStore((state) => state.forkFrom)
  const cloneBranch = useAppStore((state) => state.cloneBranch)
  const loadLineage = useAppStore((state) => state.loadLineage)
  const lineage = useAppStore((state) => state.lineage)
  const currentSessionFile = useAppStore((state) => state.sessionState?.sessionFile ?? null)
  const switchSession = useAppStore((state) => state.switchSession)

  useEffect(() => {
    loadForkMessages()
    loadLineage()
  }, [loadForkMessages, loadLineage])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Branches */}
      <div className="border-b border-neutral-800 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitFork size={15} className="text-neutral-400" />
            <h3 className="text-sm font-medium text-neutral-200">Branches</h3>
          </div>
          <button
            onClick={() => cloneBranch()}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
            title="Clone the current branch into a new session"
          >
            <Copy size={12} />
            Clone branch
          </button>
        </div>
        {forkMessages.length === 0 ? (
          <p className="text-xs text-neutral-600">No earlier messages to fork from.</p>
        ) : (
          <div className="space-y-1">
            {forkMessages.map((fp) => (
              <div
                key={fp.entryId}
                className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-neutral-800/50"
              >
                <span className="line-clamp-1 flex-1 text-xs text-neutral-400">{fp.text}</span>
                <button
                  onClick={() => forkFrom(fp.entryId)}
                  className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-neutral-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-700 hover:text-neutral-200"
                  title="Fork a new session from this message"
                >
                  <GitFork size={11} />
                  Fork
                </button>
              </div>
            ))}
          </div>
        )}
        {lineage.length > 0 && (
          <div className="mt-3 border-t border-neutral-800 pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">
              Session tree
            </div>
            <LineageTree nodes={lineage} currentPath={currentSessionFile} onSwitch={switchSession} />
          </div>
        )}
      </div>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-neutral-400" />
          <h2 className="text-sm font-medium text-neutral-200">Agent Timeline</h2>
          <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-500">
            {timelineEvents.length}
          </span>
        </div>
        <button
          onClick={clearTimeline}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300 transition-colors"
        >
          <Trash2 size={12} />
          Clear
        </button>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {timelineEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-neutral-500">
            <Activity size={32} className="mb-3 text-neutral-600" />
            <p className="text-sm">No activity yet</p>
            <p className="mt-1 text-xs text-neutral-600">Agent events will appear here in real-time</p>
          </div>
        ) : (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-4 top-0 bottom-0 w-px bg-neutral-800" />

            {/* Events */}
            <div className="space-y-1">
              {timelineEvents.map((event) => (
                <TimelineEntry key={event.id} event={event} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TimelineEntry({ event }: { event: StoreTimelineEvent }): React.JSX.Element {
  const icon = getEventIcon(event.type, event.status)
  const color = getEventColor(event.type, event.status)

  return (
    <div className="group relative flex items-start gap-3 py-2 pl-2 animate-fade-in">
      {/* Icon */}
      <div
        className={clsx(
          'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
          color
        )}
      >
        {icon}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-200">{event.title}</span>
          {event.status === 'running' && (
            <Loader2 size={12} className="animate-spin text-blue-400" />
          )}
        </div>

        {event.detail && (
          <p className="mt-0.5 text-xs text-neutral-500 line-clamp-2">{event.detail}</p>
        )}

        <div className="mt-1 flex items-center gap-2 text-xs text-neutral-600">
          <Clock size={10} />
          <span>{formatTimestamp(event.timestamp)}</span>
          {event.duration !== undefined && (
            <>
              <span className="text-neutral-700">·</span>
              <span>{formatDuration(event.duration)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function getEventIcon(type: StoreTimelineEvent['type'], status?: string): React.ReactNode {
  const size = 14

  switch (type) {
    case 'user_message':
      return <MessageSquare size={size} />
    case 'assistant_message':
      return <MessageSquare size={size} />
    case 'tool_start':
    case 'tool_end':
      return <Wrench size={size} />
    case 'thinking':
      return <Brain size={size} />
    case 'compaction':
      return <RefreshCw size={size} />
    case 'retry':
      return <RefreshCw size={size} />
    case 'error':
      return <AlertCircle size={size} />
    case 'system':
      return status === 'success' ? <CheckCircle2 size={size} /> : <Activity size={size} />
    default:
      return <Activity size={size} />
  }
}

function getEventColor(type: StoreTimelineEvent['type'], status?: string): string {
  if (status === 'error') return 'border-red-800 bg-red-900/20 text-red-400'
  if (status === 'running') return 'border-blue-800 bg-blue-900/20 text-blue-400'

  switch (type) {
    case 'user_message':
      return 'border-blue-800 bg-blue-900/20 text-blue-400'
    case 'assistant_message':
      return 'border-emerald-800 bg-emerald-900/20 text-emerald-400'
    case 'tool_start':
    case 'tool_end':
      return 'border-yellow-800 bg-yellow-900/20 text-yellow-400'
    case 'thinking':
      return 'border-purple-800 bg-purple-900/20 text-purple-400'
    case 'compaction':
      return 'border-orange-800 bg-orange-900/20 text-orange-400'
    case 'retry':
      return 'border-amber-800 bg-amber-900/20 text-amber-400'
    default:
      return 'border-neutral-700 bg-neutral-800/50 text-neutral-400'
  }
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function LineageTree({
  nodes,
  depth = 0,
  currentPath,
  onSwitch,
}: {
  nodes: LineageNode[]
  depth?: number
  currentPath: string | null
  onSwitch: (path: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <div key={node.path}>
          <button
            onClick={() => onSwitch(node.path)}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            className={clsx(
              'flex w-full items-center gap-2 rounded py-1 pr-2 text-left text-xs transition-colors',
              node.path === currentPath
                ? 'bg-blue-900/30 text-blue-300'
                : 'text-neutral-400 hover:bg-neutral-800/50'
            )}
          >
            <GitBranch size={11} className="shrink-0 text-neutral-600" />
            <span className="truncate">{node.name ?? node.sessionId.slice(0, 8)}</span>
          </button>
          {node.children.length > 0 && (
            <LineageTree
              nodes={node.children}
              depth={depth + 1}
              currentPath={currentPath}
              onSwitch={onSwitch}
            />
          )}
        </div>
      ))}
    </div>
  )
}
