import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../../shared/agent-engine-label'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import { filterModels, sortModelsByRecency } from '../utils/model-search'
import { readModelRecency, recordModelUse } from '../utils/model-recency'
import { clsx } from 'clsx'
import { Cpu, ChevronUp, Check, Loader2, Search } from 'lucide-react'

interface ModelSelectorProps {
  className?: string
  compact?: boolean
}

/**
 * Searchable model picker for the status bar.
 * Opens upward; starts the active runtime on demand, even in a fresh chat.
 */
export function ModelSelector({ className, compact = false }: ModelSelectorProps): React.JSX.Element {
  const { t } = useTranslation()
  const sessionState = useAppStore((state) => state.sessionState)
  const setModel = useAppStore((state) => state.setModel)
  const listModels = useAppStore((state) => state.listModels)
  const workspaceId = useAppStore((state) => state.activeWorkspace?.id)
  const runtimeId = useAppStore((state) => state.activeSessionRuntimeId)
  const piStatus = useAppStore((state) => state.piStatus)
  const engineLabel = useAppStore((state) => agentEngineLabel(state.piEngine) ?? DEFAULT_AGENT_ENGINE_LABEL)
  const settings = useAppStore((state) => state.settings)

  const [isOpen, setIsOpen] = useState(false)
  const modelSelectorOpenRequest = useAppStore((state) => state.modelSelectorOpenRequest)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [recency, setRecency] = useState(readModelRecency)
  // Keep errors as data: switching language must not restart the load.
  const [loadError, setLoadError] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const currentModel = sessionState?.model
  const fallbackLabel =
    currentModel?.name ??
    (settings?.defaultModel
      ? settings.defaultProvider
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : settings.defaultModel
      : t('models.selector.selectModel'))

  const close = (): void => {
    setIsOpen(false)
    setQuery('')
    setLoadError(false)
  }

  const open = (): void => {
    if (isOpen) {
      close()
      return
    }
    setModels([])
    setLoading(true)
    setIsOpen(true)
  }

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setModels([])
    setLoading(true)
    setLoadError(false)
    void listModels().then(
      (available) => {
        if (!cancelled) setModels(available)
      },
      () => {
        if (!cancelled) setLoadError(true)
      },
    ).finally(() => {
      if (!cancelled) setLoading(false)
    })
    // Never populate a different session's picker with an old RPC result.
    return () => { cancelled = true }
  }, [isOpen, workspaceId, runtimeId, listModels])

  useEffect(() => {
    if (!isOpen) return
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [isOpen])

  // Ctrl/Cmd+Shift+M opens the picker. The nonce makes a repeat press reopen it
  // after it was closed, without depending on the toggle used by the button.
  useEffect(() => {
    if (modelSelectorOpenRequest === 0) return
    setModels([])
    setLoading(true)
    setLoadError(false)
    setIsOpen(true)
  }, [modelSelectorOpenRequest])

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

  const filteredModels = useMemo(
    () => filterModels(sortModelsByRecency(models, recency), query),
    [models, recency, query],
  )

  // The first match is preselected, so Enter picks it right after typing.
  useEffect(() => setHighlighted(0), [query, models])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-model-index="${highlighted}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  const handleSelect = async (model: ModelInfo): Promise<void> => {
    if (useAppStore.getState().piStatus !== 'running') return
    await setModel(model.provider, model.id)
    setRecency(recordModelUse(model))
    close()
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (filteredModels.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlighted((i) => (i + step + filteredModels.length) % filteredModels.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const model = filteredModels[highlighted]
      if (model && !loading) void handleSelect(model)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => void open()}
        className={clsx(
          'flex items-center gap-1 px-2 text-[11px] transition-colors active:scale-[0.98]',
          isOpen ? 'bg-surface-hover text-primary' : 'text-dim hover:bg-surface-hover hover:text-secondary',
          compact ? 'h-7 max-w-36 rounded-l-[7px] rounded-r-none' : 'h-6 max-w-52 rounded-md',
        )}
        title={t('models.selector.selectModelWithShortcut', { agent: engineLabel })}
        aria-label={t('models.selector.selectModel')}
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
              <div className="text-xs text-muted">{t('models.selector.current')}</div>
              <div className="text-sm font-medium text-primary">{currentModel.name}</div>
              <div className="mt-0.5 text-xs text-dim">
                {currentModel.provider} · {currentModel.id}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search size={12} className="shrink-0 text-dim" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('models.selector.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-faint"
            />
          </div>
          <div ref={listRef} className="max-h-56 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-dim">
                <Loader2 size={12} className="animate-spin" />
                {t('common.loading')}
              </div>
            )}
            {loadError && (
              <div className="px-3 py-2 text-xs text-error">{t('models.selector.loadFailed')}</div>
            )}
            {!loading && !loadError && filteredModels.length === 0 && (
              <div className="px-3 py-2 text-xs text-dim">{t('models.selector.noModelsMatch')}</div>
            )}
            {filteredModels.map((model, index) => {
              const selected =
                currentModel?.id === model.id && currentModel?.provider === model.provider
              return (
                <button
                  key={`${model.provider}/${model.id}`}
                  type="button"
                  data-model-index={index}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => void handleSelect(model)}
                  disabled={loading || piStatus !== 'running'}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover transition-colors',
                    index === highlighted ? 'bg-surface-hover' : selected && 'bg-card'
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
        </div>
      )}
    </div>
  )
}
