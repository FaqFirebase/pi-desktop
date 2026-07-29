import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '../store'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import { filterModels } from '../utils/model-search'
import { clsx } from 'clsx'
import { Cpu, ChevronUp, Check, Loader2, Search } from 'lucide-react'

interface ModelSelectorProps {
  className?: string
}

/**
 * Searchable model picker for the status bar.
 * Opens upward; loads models when Pi is running.
 */
export function ModelSelector({ className }: ModelSelectorProps): React.JSX.Element {
  const sessionState = useAppStore((state) => state.sessionState)
  const setModel = useAppStore((state) => state.setModel)
  const piStatus = useAppStore((state) => state.piStatus)
  const settings = useAppStore((state) => state.settings)

  const [isOpen, setIsOpen] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
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
    setIsOpen(true)
    if (useAppStore.getState().piStatus === 'running') {
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

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => void open()}
        className="flex items-center gap-1 text-dim hover:text-secondary transition-colors"
        title="Select model (Ctrl+P to cycle when Pi is running)"
        aria-label="Select model"
        aria-expanded={isOpen}
      >
        <Cpu size={10} className="shrink-0" />
        <span className="min-w-0 truncate">{fallbackLabel}</span>
        <ChevronUp
          size={10}
          className={clsx('shrink-0 transition-transform', isOpen && 'rotate-180')}
        />
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-72 rounded-lg border border-border-strong bg-surface py-1 shadow-xl shadow-black/40 animate-fade-in">
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
              Start Pi to list and change models.
            </div>
          )}

          {piStatus === 'running' && (
            <>
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search size={12} className="shrink-0 text-dim" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models…"
                  className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-faint"
                />
              </div>
              <div className="max-h-56 overflow-y-auto py-1">
                {loading && (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-dim">
                    <Loader2 size={12} className="animate-spin" />
                    Loading…
                  </div>
                )}
                {error && <div className="px-3 py-2 text-xs text-error">{error}</div>}
                {!loading && !error && filteredModels.length === 0 && (
                  <div className="px-3 py-2 text-xs text-dim">No models match</div>
                )}
                {filteredModels.map((model) => {
                  const selected =
                    currentModel?.id === model.id && currentModel?.provider === model.provider
                  return (
                    <button
                      key={`${model.provider}/${model.id}`}
                      type="button"
                      onClick={() => void handleSelect(model)}
                      className={clsx(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover transition-colors',
                        selected && 'bg-card'
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-primary">{model.name}</div>
                        <div className="truncate text-xs text-dim">
                          {model.provider} · {model.id}
                        </div>
                      </div>
                      {selected && <Check size={12} className="shrink-0 text-success" />}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
