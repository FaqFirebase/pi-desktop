import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { ModelSelector } from './model-selector'
import { clsx } from 'clsx'
import {
  PanelLeft,
  PanelLeftClose,
  Terminal,
  Zap,
  DollarSign,
  Layers,
  Minimize2,
  Settings,
  Loader2,
  ChevronUp,
  Check,
  GitBranch,
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
      </div>

      {/* Right section */}
      <div className="flex items-center gap-3">
        {/* Model selector */}
        <ModelSelector placement="up" variant="status" />

        {/* Thinking level */}
        <ThinkingLevelSelector />

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

// ─── Thinking Level Selector ─────────────────────────────────────────────────

function ThinkingLevelSelector(): React.JSX.Element {
  const sessionState = useAppStore((state) => state.sessionState)
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const piStatus = useAppStore((state) => state.piStatus)

  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
  const currentLevel = sessionState?.thinkingLevel ?? 'medium'

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  if (piStatus !== 'running') return <></>

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-dim hover:text-secondary transition-colors"
        title="Thinking level"
      >
        <Zap size={10} />
        <span>{currentLevel}</span>
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-32 rounded-lg border border-border-strong bg-surface shadow-xl shadow-black/40 py-1 animate-fade-in z-50">
          {levels.map((level) => (
            <button
              key={level}
              onClick={() => {
                setThinkingLevel(level)
                setIsOpen(false)
              }}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-surface-hover transition-colors',
                currentLevel === level
                  ? 'text-primary'
                  : 'text-muted'
              )}
            >
              {currentLevel === level && <Check size={10} className="text-success" />}
              <span className={currentLevel === level ? '' : 'ml-[18px]'}>{level}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
