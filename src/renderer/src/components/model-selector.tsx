import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '../store'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import { filterModels } from '../utils/model-search'
import { clsx } from 'clsx'
import { Cpu, ChevronUp, Check, Loader2, Search } from 'lucide-react'

interface ModelSelectorProps {
  /** Dropdown opens above (status bar) or below (home composer). */
  placement?: 'up' | 'down'
  /** Composer toolbar styling vs compact status-bar chrome. */
  variant?: 'status' | 'composer'
  /**
   * When Pi is stopped, attempt to start it (needs an active workspace) so the
   * model list can load. Used on minimal home where Pi is usually lazy.
   */
  startPiIfNeeded?: boolean
  /** Optional prep before start (e.g. switch to the home project picker workspace). */
  ensurePiReady?: () => Promise<void>
  className?: string
}

/**
 * Searchable model picker. Shared by the status bar and the minimal home
 * composer so both surfaces stay in sync.
 */
export function ModelSelector({
  placement = 'up',
  variant = 'status',
  startPiIfNeeded = false,
  ensurePiReady,
  className,
}: ModelSelectorProps): React.JSX.Element {
  const sessionState = useAppStore((state) => state.sessionState)
  const setModel = useAppStore((state) => state.setModel)
  const startPi = useAppStore((state) => state.startPi)
  const piStatus = useAppStore((state) => state.piStatus)
  const settings = useAppStore((state) => state.settings)

  const [isOpen, setIsOpen] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const currentModel = sessionState?.model
  const fallbackLabel =
    currentModel?.name ??
    (settings?.defaultModel
      ? settings.defaultProvider
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : settings.defaultModel
      : 'Select model')

  const close = (): void => {
    setIsOpen(false)
    setQuery('')
    setError(null)
  }

  const loadModels = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const response = (await window.piDesktop.model.listAvailable()) as {
        success?: boolean
        data?: { models?: ModelInfo[] }
      } | null
      if (response?.success && response.data?.models) {
        setModels(response.data.models)
      } else {
        setModels([])
      }
    } catch {
      setModels([])
      setError('Could not load models')
    } finally {
      setLoading(false)
    }
  }

  const open = async (): Promise<void> => {
    if (isOpen) {
      close()
      return
    }

    let status = useAppStore.getState().piStatus
    if (status !== 'running' && startPiIfNeeded) {
      setStarting(true)
      setError(null)
      try {
        if (ensurePiReady) await ensurePiReady()
        await startPi()
        status = useAppStore.getState().piStatus
        if (status !== 'running') {
          setError('Pi did not start — pick a project first')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start Pi')
        setStarting(false)
        setIsOpen(true)
        return
      }
      setStarting(false)
    }

    setIsOpen(true)
    if (status === 'running') {
      void loadModels()
    }
  }

  useEffect(() => {
    if (!isOpen || piStatus !== 'running') return
    void loadModels()
  }, [isOpen, piStatus])

  useEffect(() => {
    if (!isOpen) return
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        close()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const filteredModels = useMemo(() => filterModels(models, query), [models, query])

  const handleSelect = async (model: ModelInfo): Promise<void> => {
    if (useAppStore.getState().piStatus === 'running') {
      await setModel(model.provider, model.id)
    } else {
      // Persist preferred model for the next Pi start.
      const updated = await window.piDesktop.settings.save({
        defaultProvider: model.provider,
        defaultModel: model.id,
      })
      useAppStore.setState({ settings: updated })
    }
    close()
  }

  const triggerClass =
    variant === 'composer'
      ? 'hover:bg-highlight-strong flex max-w-[160px] items-center gap-1 rounded-md px-2 py-1 text-xs text-secondary hover:text-primary transition-colors'
      : 'flex items-center gap-1 text-dim hover:text-secondary transition-colors'

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => void open()}
        disabled={starting}
        className={triggerClass}
        title="Select model (Ctrl+P to cycle when Pi is running)"
        aria-label="Select model"
        aria-expanded={isOpen}
      >
        {starting ? (
          <Loader2 size={variant === 'composer' ? 12 : 10} className="shrink-0 animate-spin" />
        ) : (
          <Cpu size={variant === 'composer' ? 12 : 10} className="shrink-0" />
        )}
        <span className="min-w-0 truncate">{starting ? 'Starting…' : fallbackLabel}</span>
        <ChevronUp
          size={variant === 'composer' ? 12 : 10}
          className={clsx(
            'shrink-0 transition-transform',
            placement === 'down' ? (isOpen ? 'rotate-180' : '') : isOpen ? 'rotate-180' : ''
          )}
        />
      </button>

      {isOpen && (
        <div
          className={clsx(
            'absolute z-50 w-72 rounded-lg border border-border-strong bg-surface py-1 shadow-xl shadow-black/40 animate-fade-in',
            placement === 'up' ? 'bottom-full right-0 mb-1' : 'top-full left-0 mt-1'
          )}
        >
          {currentModel && (
            <div className="border-b border-border px-3 py-2">
              <div className="text-xs text-muted">Current</div>
              <div className="text-sm font-medium text-primary">{currentModel.name}</div>
              <div className="mt-0.5 text-xs text-dim">
                {currentModel.provider} · {currentModel.id}
              </div>
            </div>
          )}

          {piStatus !== 'running' && (
            <div className="border-b border-border px-3 py-2 text-xs text-dim">
              {startPiIfNeeded
                ? 'Pi is not running — pick a project and start a session, or open the picker again after Pi starts.'
                : 'Start Pi to list and change models.'}
            </div>
          )}

          {error && (
            <div className="border-b border-border px-3 py-2 text-xs text-error">{error}</div>
          )}

          {piStatus === 'running' && (
            <>
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

              <div className="max-h-64 overflow-y-auto py-1">
                {loading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 size={16} className="animate-spin text-dim" />
                  </div>
                ) : models.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-faint">No models available</div>
                ) : filteredModels.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-faint">
                    No models match “{query.trim()}”
                  </div>
                ) : (
                  filteredModels.map((model) => (
                    <button
                      key={`${model.provider}/${model.id}`}
                      type="button"
                      onClick={() => void handleSelect(model)}
                      className={clsx(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover',
                        currentModel?.id === model.id &&
                          currentModel?.provider === model.provider &&
                          'bg-card'
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-primary">{model.name}</span>
                          {currentModel?.id === model.id &&
                            currentModel?.provider === model.provider && (
                              <Check size={12} className="shrink-0 text-success" />
                            )}
                        </div>
                        <div className="mt-0.5 text-[10px] text-faint">
                          {model.provider} · ctx: {(model.contextWindow / 1000).toFixed(0)}k
                          {model.reasoning && ' · reasoning'}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
                <span className="text-[10px] text-faint">
                  {query.trim()
                    ? `${filteredModels.length} of ${models.length}`
                    : 'Ctrl+P to cycle'}
                </span>
                <button
                  type="button"
                  onClick={close}
                  className="text-[10px] text-faint hover:text-muted"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
