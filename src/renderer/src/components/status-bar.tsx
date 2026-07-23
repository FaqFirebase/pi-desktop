import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '../store'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import { clsx } from 'clsx'
import {
  PanelLeft,
  PanelLeftClose,
  Terminal,
  Cpu,
  Zap,
  DollarSign,
  Layers,
  Minimize2,
  Settings,
  Loader2,
  ChevronUp,
  Check,
  GitBranch,
  Search,
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
        <ModelSelector />

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

// ─── Model Selector ──────────────────────────────────────────────────────────

/** Collapse case/punctuation so "sonnet 4" matches "claude-sonnet-4". */
function normalizeModelSearchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Token AND match against name, id, and provider. Every whitespace-separated
 * query term must appear somewhere (as a substring) in the normalized haystack,
 * so partial names work without typing the exact model slug.
 */
function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const tokens = normalizeModelSearchText(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return models
  return models.filter((m) => {
    const haystack = normalizeModelSearchText(`${m.name} ${m.id} ${m.provider}`)
    return tokens.every((t) => haystack.includes(t))
  })
}

function ModelSelector(): React.JSX.Element {
  const sessionState = useAppStore((state) => state.sessionState)
  const setModel = useAppStore((state) => state.setModel)
  const piStatus = useAppStore((state) => state.piStatus)

  const [isOpen, setIsOpen] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const currentModel = sessionState?.model

  const close = (): void => {
    setIsOpen(false)
    setQuery('')
  }

  // Load models when opened
  useEffect(() => {
    if (!isOpen || piStatus !== 'running') return

    const loadModels = async () => {
      setLoading(true)
      try {
        const response = await window.piDesktop.model.listAvailable() as {
          success?: boolean
          data?: { models?: ModelInfo[] }
        } | null
        if (response?.success && response.data?.models) {
          setModels(response.data.models)
        }
      } catch {
        // Silent failure
      } finally {
        setLoading(false)
      }
    }

    loadModels()
  }, [isOpen, piStatus])

  // Focus search when the menu opens
  useEffect(() => {
    if (!isOpen) return
    // Defer so the input is mounted before focusing.
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [isOpen])

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        close()
      }
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const filteredModels = useMemo(
    () => filterModels(models, query),
    [models, query]
  )

  const handleSelect = async (model: ModelInfo) => {
    await setModel(model.provider, model.id)
    close()
  }

  if (piStatus !== 'running') return <></>

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        className="flex items-center gap-1 text-dim hover:text-secondary transition-colors"
        title="Select model (Ctrl+P to cycle)"
      >
        <Cpu size={10} />
        <span className="max-w-[140px] truncate">
          {currentModel?.name ?? 'No model'}
        </span>
        <ChevronUp size={10} className={clsx('transition-transform', isOpen && 'rotate-180')} />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-72 rounded-lg border border-border-strong bg-surface shadow-xl shadow-black/40 py-1 animate-fade-in z-50">
          {/* Current model */}
          {currentModel && (
            <div className="px-3 py-2 border-b border-border">
              <div className="text-xs text-muted">Current</div>
              <div className="text-sm text-primary font-medium">{currentModel.name}</div>
              <div className="text-xs text-dim mt-0.5">
                {currentModel.provider} · {currentModel.id}
              </div>
            </div>
          )}

          {/* Search */}
          <div className="border-b border-border px-2 py-1.5">
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1">
              <Search size={12} className="shrink-0 text-dim" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    if (query) setQuery('')
                    else close()
                  }
                }}
                placeholder="Search models..."
                className="min-w-0 flex-1 bg-transparent text-xs text-primary placeholder:text-faint outline-none"
                aria-label="Search models"
              />
            </div>
          </div>

          {/* Model list */}
          <div className="max-h-64 overflow-y-auto py-1">
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={16} className="animate-spin text-dim" />
              </div>
            ) : models.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-faint">
                No models available
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-faint">
                No models match “{query.trim()}”
              </div>
            ) : (
              filteredModels.map((model) => (
                <button
                  key={`${model.provider}/${model.id}`}
                  onClick={() => handleSelect(model)}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-hover transition-colors',
                    currentModel?.id === model.id && currentModel?.provider === model.provider && 'bg-card'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-primary">{model.name}</span>
                      {currentModel?.id === model.id && currentModel?.provider === model.provider && (
                        <Check size={12} className="text-success shrink-0" />
                      )}
                    </div>
                    <div className="text-[10px] text-faint mt-0.5">
                      {model.provider} · ctx: {(model.contextWindow / 1000).toFixed(0)}k
                      {model.reasoning && ' · reasoning'}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-3 py-1.5 flex items-center justify-between">
            <span className="text-[10px] text-faint">
              {query.trim()
                ? `${filteredModels.length} of ${models.length}`
                : 'Ctrl+P to cycle'}
            </span>
            <button
              onClick={close}
              className="text-[10px] text-faint hover:text-muted"
            >
              Close
            </button>
          </div>
        </div>
      )}
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
