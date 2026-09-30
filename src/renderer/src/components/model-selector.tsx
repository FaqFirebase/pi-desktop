import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../../shared/agent-engine-label'
import { formatShortcut } from '../../../shared/keyboard-shortcuts'
import { activeShortcuts } from '../utils/app-shortcuts'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import { filterModels, sortModelsByRecency } from '../utils/model-search'
import { readModelRecency, recordModelUse } from '../utils/model-recency'
import { thinkingLevels, stepThinkingLevel } from '../utils/thinking-levels'
import { clsx } from 'clsx'
import { ArrowLeft, ArrowRight, Cpu, ChevronUp, Check, Loader2, Search } from 'lucide-react'

const setIsOpen = (modelPickerOpen: boolean): void => useAppStore.setState({ modelPickerOpen })

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
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const listModels = useAppStore((state) => state.listModels)
  const workspaceId = useAppStore((state) => state.activeWorkspace?.id)
  const runtimeId = useAppStore((state) => state.activeSessionRuntimeId)
  const piStatus = useAppStore((state) => state.piStatus)
  const engineLabel = useAppStore((state) => agentEngineLabel(state.piEngine) ?? DEFAULT_AGENT_ENGINE_LABEL)
  const modelSelectorShortcut = useAppStore((state) => activeShortcuts(state).modelSelector)
  const settings = useAppStore((state) => state.settings)

  const isOpen = useAppStore((state) => state.modelPickerOpen)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [effortDraft, setEffortDraft] = useState<{ model: ModelInfo; level: string } | null>(null)
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
    setEffortDraft(null)
    setLoadError(false)
  }

  const open = (): void => {
    if (isOpen) {
      close()
      return
    }
    setIsOpen(true)
  }

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setEffortDraft(null)
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

  const highlightedModel = filteredModels[highlighted]
  const draftFor = (model: ModelInfo | undefined): string | undefined =>
    model && effortDraft?.model.id === model.id && effortDraft.model.provider === model.provider
      ? effortDraft.level
      : undefined
  const displayedEffort = draftFor(highlightedModel) ?? sessionState?.thinkingLevel ?? 'medium'

  // setModel reports its own failures in the chat, so the picker always closes.
  // With the runtime stopped, setModel saves the model as the default.
  const handleSelect = async (model: ModelInfo): Promise<void> => {
    const effort = draftFor(model)
    await setModel(model.provider, model.id)
    if (effort !== undefined) await setThinkingLevel(effort)
    setRecency(recordModelUse(model))
    close()
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (filteredModels.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlighted((i) => (i + step + filteredModels.length) % filteredModels.length)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      if (loading || piStatus !== 'running' || !highlightedModel) return
      const next = stepThinkingLevel(
        thinkingLevels(highlightedModel), displayedEffort, e.key === 'ArrowRight' ? 1 : -1,
      )
      setEffortDraft({ model: highlightedModel, level: next })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const model = filteredModels[highlighted]
      if (model && !loading) void handleSelect(model)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
      // Closing unmounts the focused search box; hand focus back to the
      // composer, as a confirmed selection does.
      useAppStore.setState({ composerFocusRequested: true })
    }
  }

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => void open()}
        className={clsx(
          'flex h-6 max-w-52 items-center gap-1 rounded-md px-2 text-[11px] transition-colors active:scale-[0.98]',
          isOpen ? 'bg-surface-hover text-primary' : 'text-dim hover:bg-surface-hover hover:text-secondary',
          compact && 'max-w-36',
        )}
        // The label may be truncated, so the tooltip always names the model.
        title={t('models.selector.currentModelTitle', {
          model: fallbackLabel,
          hint: modelSelectorShortcut
            ? t('models.selector.selectModelWithShortcut', {
                agent: engineLabel,
                shortcut: formatShortcut(modelSelectorShortcut, window.piDesktop.system.platform),
              })
            : t('models.selector.selectModelCycleHint', { agent: engineLabel }),
        })}
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
          {highlightedModel && (
            <div className="flex items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted" aria-live="polite">
              <span className="min-w-0 flex-1 truncate">
                {t('thinking.effortWithLevel', { level: displayedEffort })}
              </span>
              <ArrowLeft size={12} aria-hidden="true" />
              <ArrowRight size={12} aria-hidden="true" />
            </div>
          )}
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
                  disabled={loading}
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
