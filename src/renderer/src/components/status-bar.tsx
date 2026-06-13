import { useState, useEffect, useRef } from 'react'
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
  Settings,
  Loader2,
  ChevronUp,
  Check,
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

  return (
    <div className="flex h-7 items-center justify-between border-t border-neutral-800 bg-neutral-950 px-3 text-xs">
      {/* Left section */}
      <div className="flex items-center gap-3">
        {/* PI Status */}
        <div className="flex items-center gap-1.5">
          <div
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              piStatus === 'running' && 'bg-emerald-500',
              piStatus === 'starting' && 'bg-yellow-500 animate-pulse',
              piStatus === 'error' && 'bg-red-500',
              piStatus === 'stopped' && 'bg-neutral-600'
            )}
          />
          <span className="text-neutral-500">
            {piStatus === 'running' ? `PI running (PID: ${piPid})` : `PI ${piStatus}`}
          </span>
        </div>

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-1 text-blue-400">
            <Loader2 size={10} className="animate-spin" />
            <span>streaming</span>
          </div>
        )}

        {/* Queue indicators */}
        {pendingSteering.length > 0 && (
          <span className="text-yellow-500">
            {pendingSteering.length} steer queued
          </span>
        )}
        {pendingFollowUp.length > 0 && (
          <span className="text-yellow-500">
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
          <div className="flex items-center gap-1 text-neutral-500" title={`Context: ${sessionStats.contextUsage.tokens?.toLocaleString() ?? '?'} / ${sessionStats.contextUsage.contextWindow.toLocaleString()} tokens`}>
            <Layers size={10} />
            <span>
              {sessionStats.contextUsage.percent !== null
                ? `${sessionStats.contextUsage.percent}%`
                : '?'}
            </span>
          </div>
        )}

        {/* Cost */}
        {sessionStats?.cost !== undefined && sessionStats.cost > 0 && (
          <div className="flex items-center gap-1 text-neutral-500">
            <DollarSign size={10} />
            <span>${sessionStats.cost.toFixed(2)}</span>
          </div>
        )}

        {/* Toggle sidebar */}
        <button
          onClick={toggleSidebar}
          className="rounded p-0.5 text-neutral-500 hover:text-neutral-300 transition-colors"
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
            terminalOpen ? 'text-blue-400' : 'text-neutral-500 hover:text-neutral-300'
          )}
          title={terminalOpen ? 'Hide terminal' : 'Show terminal'}
          aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
        >
          <Terminal size={12} />
        </button>

        {/* Settings */}
        <button
          onClick={() => setCurrentView('settings')}
          className="rounded p-0.5 text-neutral-500 hover:text-neutral-300 transition-colors"
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

function ModelSelector(): React.JSX.Element {
  const sessionState = useAppStore((state) => state.sessionState)
  const setModel = useAppStore((state) => state.setModel)
  const piStatus = useAppStore((state) => state.piStatus)

  const [isOpen, setIsOpen] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const currentModel = sessionState?.model

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

  const handleSelect = async (model: ModelInfo) => {
    await setModel(model.provider, model.id)
    setIsOpen(false)
  }

  if (piStatus !== 'running') return <></>

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-neutral-500 hover:text-neutral-300 transition-colors"
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
        <div className="absolute bottom-full right-0 mb-1 w-72 rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl shadow-black/40 py-1 animate-fade-in z-50">
          {/* Current model */}
          {currentModel && (
            <div className="px-3 py-2 border-b border-neutral-800">
              <div className="text-xs text-neutral-400">Current</div>
              <div className="text-sm text-neutral-200 font-medium">{currentModel.name}</div>
              <div className="text-xs text-neutral-500 mt-0.5">
                {currentModel.provider} · {currentModel.id}
              </div>
            </div>
          )}

          {/* Model list */}
          <div className="max-h-64 overflow-y-auto py-1">
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={16} className="animate-spin text-neutral-500" />
              </div>
            ) : models.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-neutral-600">
                No models available
              </div>
            ) : (
              models.map((model) => (
                <button
                  key={`${model.provider}/${model.id}`}
                  onClick={() => handleSelect(model)}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-800 transition-colors',
                    currentModel?.id === model.id && 'bg-neutral-800'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-neutral-200">{model.name}</span>
                      {currentModel?.id === model.id && (
                        <Check size={12} className="text-emerald-400 shrink-0" />
                      )}
                    </div>
                    <div className="text-[10px] text-neutral-600 mt-0.5">
                      {model.provider} · ctx: {(model.contextWindow / 1000).toFixed(0)}k
                      {model.reasoning && ' · reasoning'}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-neutral-800 px-3 py-1.5 flex items-center justify-between">
            <span className="text-[10px] text-neutral-600">Ctrl+P to cycle</span>
            <button
              onClick={() => setIsOpen(false)}
              className="text-[10px] text-neutral-600 hover:text-neutral-400"
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
        className="flex items-center gap-1 text-neutral-500 hover:text-neutral-300 transition-colors"
        title="Thinking level"
      >
        <Zap size={10} />
        <span>{currentLevel}</span>
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-32 rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl shadow-black/40 py-1 animate-fade-in z-50">
          {levels.map((level) => (
            <button
              key={level}
              onClick={() => {
                setThinkingLevel(level)
                setIsOpen(false)
              }}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-neutral-800 transition-colors',
                currentLevel === level
                  ? 'text-neutral-200'
                  : 'text-neutral-400'
              )}
            >
              {currentLevel === level && <Check size={10} className="text-emerald-400" />}
              <span className={currentLevel === level ? '' : 'ml-[18px]'}>{level}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
