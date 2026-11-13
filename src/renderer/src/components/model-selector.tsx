import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatSession } from '../chat-session-context'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../../shared/agent-engine-label'
import { formatShortcut } from '../../../shared/keyboard-shortcuts'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import { filterModels, sortModelsByRecency } from '../utils/model-search'
import { readModelRecency, recordModelUse } from '../utils/model-recency'
import { thinkingLevels, stepThinkingLevel } from '../utils/thinking-levels'
import { clsx } from 'clsx'
import { ArrowLeft, ArrowRight, Cpu, ChevronUp, Check, Loader2, Search } from 'lucide-react'
import { isImeComposing } from '../utils/ime-composing'

interface ModelSelectorProps {
  className?: string
  compact?: boolean
}

/** Searchable model and effort picker shared by every chat surface. */
export function ModelSelector(props: ModelSelectorProps): React.JSX.Element {
  const { models } = useChatSession()
  return <SessionModelSelector key={models.scopeKey} {...props} />
}

function SessionModelSelector({ className, compact = false }: ModelSelectorProps): React.JSX.Element {
  const { t } = useTranslation()
  const { models: binding, engine, settings, composer } = useChatSession()
  const { open: isOpen, setOpen: setIsOpen } = binding
  const listModels = binding.list
  const engineLabel = agentEngineLabel(engine) ?? DEFAULT_AGENT_ENGINE_LABEL
  const modelSelectorShortcut = settings.shortcuts.modelSelector
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [effortDraft, setEffortDraft] = useState<{ model: ModelInfo; level: string } | null>(null)
  const [recency, setRecency] = useState(readModelRecency)
  // Keep errors as data: switching language must not restart the load.
  const [loadError, setLoadError] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const selectionPending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const pending = binding.pendingModel
  const selectedProvider = pending?.provider ?? binding.model?.provider ?? (binding.useDefaults ? settings.defaultProvider : undefined)
  const selectedId = pending?.modelId ?? binding.model?.id ?? (binding.useDefaults ? settings.defaultModel : undefined)
  const currentModel = models.find((model) => model.id === selectedId && model.provider === selectedProvider)
    ?? (binding.model?.id === selectedId && binding.model?.provider === selectedProvider ? binding.model : null)
  const fallbackLabel = pending?.name ?? currentModel?.name
    ?? (selectedId ? selectedProvider ? `${selectedProvider}/${selectedId}` : selectedId : t('models.selector.selectModel'))
  const currentEffort = binding.pendingThinkingLevel ?? binding.thinkingLevel ?? (binding.useDefaults ? settings.defaultThinkingLevel : null) ?? 'medium'

  const close = useCallback((): void => {
    setIsOpen(false)
    setQuery('')
    setEffortDraft(null)
    setLoadError(false)
  }, [setIsOpen])

  const open = (): void => {
    if (binding.locked || selecting) return
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
    setQuery('')
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
  }, [isOpen, binding.scopeKey, listModels])

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
  }, [isOpen, close])

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
  const displayedEffort = draftFor(highlightedModel) ?? currentEffort

  const handleSelect = async (model: ModelInfo): Promise<void> => {
    if (binding.locked || selectionPending.current) return
    selectionPending.current = true
    setSelecting(true)
    setActionError(null)
    const effort = draftFor(model)
    try {
      await binding.select(model)
      if (!mounted.current) return
      if (effort !== undefined) await binding.selectThinking(effort)
      if (!mounted.current) return
      setRecency(recordModelUse(model))
      close()
      composer.requestFocus()
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      selectionPending.current = false
      if (mounted.current) setSelecting(false)
    }
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e.nativeEvent)) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (filteredModels.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlighted((i) => (i + step + filteredModels.length) % filteredModels.length)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      e.preventDefault()
      e.stopPropagation()
      if (loading || selecting || binding.locked || !highlightedModel) return
      const next = stepThinkingLevel(
        thinkingLevels(highlightedModel), displayedEffort, e.key === 'ArrowRight' ? 1 : -1,
      )
      setEffortDraft({ model: highlightedModel, level: next })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const model = filteredModels[highlighted]
      if (model && !loading && !binding.locked && !selecting) void handleSelect(model)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      composer.requestFocus()
    }
  }

  return (
    // flex: lets the trigger shrink with its wrapper (truncating the label)
    // instead of overflowing onto the thinking selector beside it.
    <div ref={ref} className={clsx('relative flex', className)}>
      <button
        type="button"
        disabled={binding.locked || selecting}
        onClick={() => void open()}
        className={clsx(
          'flex items-center gap-1 px-2 text-[11px] transition-colors active:scale-[0.98]',
          isOpen ? 'bg-surface-hover text-primary' : 'text-dim hover:bg-surface-hover hover:text-secondary',
          // min-w-0: without it the button keeps its full label width and a
          // narrow toolbar draws it over the thinking selector.
          compact ? 'h-7 min-w-0 max-w-36 rounded-l-[7px] rounded-r-none' : 'h-6 max-w-52 rounded-md',
        )}
        // The label may be truncated, so the tooltip always names the model.
        title={t('models.selector.currentModelTitle', {
          model: fallbackLabel,
          hint: modelSelectorShortcut
            ? t('models.selector.selectModelWithShortcut', {
                agent: engineLabel,
                shortcut: formatShortcut(modelSelectorShortcut, /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'linux'),
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
          {selectedId && (
            <div className="border-b border-border px-3 py-2">
              <div className="text-xs text-muted">{t('models.selector.current')}</div>
              <div className="text-sm font-medium text-primary">{fallbackLabel}</div>
              <div className="mt-0.5 text-xs text-dim">
                {selectedProvider} · {selectedId}
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
            {actionError && (
              <div role="alert" className="px-3 py-2 text-xs text-error">{t('store.messages.error', { detail: actionError })}</div>
            )}
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
                selectedId === model.id && selectedProvider === model.provider
              return (
                <button
                  key={`${model.provider}/${model.id}`}
                  type="button"
                  data-model-index={index}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => void handleSelect(model)}
                  disabled={loading || selecting || binding.locked}
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
