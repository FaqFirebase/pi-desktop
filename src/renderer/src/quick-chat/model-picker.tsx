import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { clsx } from 'clsx'
import { Brain, Check, Loader2, Search, X } from 'lucide-react'
import { t } from '../../../shared/i18n'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import type { QuickChatApi } from '../../../shared/quick-chat'
import { filterModels, sortModelsByRecency } from '../utils/model-search'
import { readModelRecency, recordModelUse } from '../utils/model-recency'
import { thinkingLevels } from '../utils/thinking-levels'

interface ModelPickerProps {
  api: QuickChatApi
  open: boolean
  onClose: () => void
  /** Which tab is active; controlled so the bottom bar can open either one. */
  tab: 'model' | 'thinking'
  onTabChange: (tab: 'model' | 'thinking') => void
  currentModel: ModelInfo | null
  /** Draft-pending model choice (stopped/new-task), if any. */
  preparedModel: { provider: string; modelId: string } | null
  thinkingLevel: string | null
  preparedThinkingLevel: string | null
  /** Null while switching is refused: the picker stays usable for drafts. */
  locked: boolean
  onPickModel: (model: ModelInfo) => void
  onPickThinking: (level: string) => void
  /** The global default a new task starts with; its real effort list resolves from the catalog. */
  defaultModel: { provider: string; modelId: string } | null
  /** The saved default effort; the highlighted level before any choice. */
  defaultThinkingLevel: string | null
  workspaceId: string | null
  anchorRef: RefObject<HTMLDivElement | null>
}

/**
 * Compact model + thinking picker for the Quick Chat bottom bar. Mirror of the
 * main window's ModelSelector interaction (search, keyboard nav, recency
 * ordering) without importing the main-window store: the catalog comes from
 * `api.listModels()` — the bound runtime when live, else a short-lived
 * metadata query process.
 */
export const ModelPicker = memo(function ModelPicker({
  api, open, onClose, tab, onTabChange, currentModel, preparedModel, defaultModel, defaultThinkingLevel, thinkingLevel, preparedThinkingLevel, locked, onPickModel, onPickThinking, workspaceId, anchorRef,
}: ModelPickerProps): React.JSX.Element | null {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [recency, setRecency] = useState(readModelRecency)
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setQuery('')
    setHighlighted(0)
    setLoadFailed(false)
    setModels([])
    setLoading(true)
    // The catalog is queried from the popup's own target (draft project or
    // the no-project home bucket), never main's active workspace.
    void api.listModels(workspaceId).then(
      (available) => { if (!cancelled) setModels(available) },
      () => { if (!cancelled) setLoadFailed(true) },
    ).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, api, workspaceId])

  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      if (tab === 'model') searchRef.current?.focus()
      else listRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [open, tab])

  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!ref.current?.contains(target) && !anchorRef.current?.contains(target)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, onClose, anchorRef])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => document.removeEventListener('keydown', handleKey, true)
  }, [open, onClose])

  const filteredModels = useMemo(
    () => filterModels(sortModelsByRecency(models, recency), query),
    [models, recency, query],
  )

  useEffect(() => setHighlighted(0), [query, models, tab])

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.querySelector<HTMLElement>(`[data-option-index="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlighted, open, tab])

  // The effort list follows the model the next send would actually use: a
  // draft-pending pick first, else the live session's model, else — for a new
  // task nobody re-picked — the global default resolved against the loaded
  // catalog. Without that last step a new task offers the generic level list
  // even when the default model declares its own efforts.
  const effectiveModel = useMemo(
    () => preparedModel
      ? models.find((m) => m.provider === preparedModel.provider && m.id === preparedModel.modelId) ?? null
      : currentModel
        ?? (defaultModel
          ? models.find((m) => m.provider === defaultModel.provider && m.id === defaultModel.modelId) ?? null
          : null),
    [preparedModel, models, currentModel, defaultModel],
  )
  const levels = thinkingLevels(effectiveModel)
  const effectiveThinking = preparedThinkingLevel ?? thinkingLevel ?? defaultThinkingLevel ?? 'medium'

  if (!open) return null

  const pickModel = (model: ModelInfo): void => {
    setRecency(recordModelUse(model))
    onPickModel(model)
    onClose()
  }

  return (
    <div
      ref={ref}
      className="mx-3 mb-2 flex flex-1 min-h-0 flex-col rounded-xl border border-border-strong bg-surface overflow-hidden qc-no-drag"
      role="dialog"
      aria-label={tab === 'model' ? t('models.selector.selectModel') : t('quickChat.thinking')}
    >
      {tab === 'model' ? (
        <>
          {/* Search Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-surface/40">
            <Search size={13} className="text-muted shrink-0" />
            <input
              ref={searchRef}
              aria-label={t('models.selector.searchPlaceholder')}
              placeholder={t('models.selector.searchPlaceholder')}
              value={query}
              className="flex-1 min-w-0 bg-transparent text-xs text-primary placeholder:text-muted/60 outline-none"
              onChange={(event) => { setQuery(event.target.value); setHighlighted(0) }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  setHighlighted((value) => Math.max(0, Math.min(filteredModels.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
                } else if (event.key === 'Enter' && filteredModels[highlighted]) {
                  event.preventDefault()
                  void pickModel(filteredModels[highlighted])
                } else if (event.key === 'Tab') {
                  event.preventDefault()
                  onTabChange('thinking')
                }
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); setHighlighted(0) }}
                className="p-0.5 text-muted hover:text-primary transition-colors"
              >
                <X size={11} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-muted hover:text-primary transition-colors p-0.5 ml-0.5"
              aria-label={t('common.close')}
            >
              <X size={12} />
            </button>
          </div>

          {/* Model List */}
          <div ref={listRef} role="listbox" aria-label={t('models.selector.selectModel')} className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted">
                <Loader2 size={13} className="animate-spin text-accent" />
                <span>{t('quickChat.loading')}</span>
              </div>
            )}
            {!loading && loadFailed && (
              <div className="py-8 text-center text-xs text-error px-3">{t('models.selector.loadFailed')}</div>
            )}
            {!loading && !loadFailed && filteredModels.map((model, index) => {
              const isCurrent = currentModel?.provider === model.provider && currentModel?.id === model.id
              const isPrepared = preparedModel?.provider === model.provider && preparedModel?.modelId === model.id
              const isSelected = isCurrent || isPrepared
              const isHighlighted = index === highlighted
              return (
                <button
                  key={`${model.provider}/${model.id}`}
                  type="button"
                  role="option"
                  title={`${model.provider} · ${model.id}`}
                  aria-selected={isSelected}
                  data-option-index={index}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => { void pickModel(model) }}
                  className={clsx(
                    'w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-lg text-left transition-all',
                    isHighlighted
                      ? 'bg-accent/10 text-primary ring-1 ring-accent/30'
                      : isSelected
                        ? 'bg-card text-primary'
                        : 'hover:bg-surface-hover/80 text-secondary hover:text-primary',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-primary">
                        {model.name || model.id}
                      </span>
                      <span className="shrink-0 text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-surface/80 border border-border/50 text-muted">
                        {model.provider}
                      </span>
                    </div>
                    <div className="truncate text-[10px] text-muted font-mono mt-0.5">
                      {model.id}
                    </div>
                  </div>
                  {isSelected && (
                    <Check size={13} className={clsx('shrink-0', isPrepared ? 'text-accent animate-pulse' : 'text-accent')} />
                  )}
                </button>
              )
            })}
            {!loading && !loadFailed && filteredModels.length === 0 && (
              <div className="py-8 text-center text-xs text-muted">{t('models.selector.noModelsMatch')}</div>
            )}
          </div>

          {/* Footer */}
          <div className="shrink-0 px-3 py-1.5 border-t border-border/50 flex items-center justify-between text-[10px] text-muted bg-surface/30 select-none">
            <span>{t('chat.commandPopup.selectHint')}</span>
            <span>{filteredModels.length} / {models.length}</span>
          </div>

        </>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-surface/40 select-none">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
              <Brain size={12} className="text-accent shrink-0" />
              <span>{t('thinking.effort')}</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted hover:text-primary transition-colors p-0.5"
              aria-label={t('common.close')}
            >
              <X size={12} />
            </button>
          </div>

          {/* Thinking Levels List */}
          <div
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-label={t('quickChat.thinking')}
            className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5 outline-none"
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlighted((value) => Math.max(0, Math.min(levels.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
              } else if (event.key === 'Enter' && levels[highlighted]) {
                event.preventDefault()
                onPickThinking(levels[highlighted])
                onClose()
              } else if (event.key === 'Tab') {
                event.preventDefault()
                onTabChange('model')
              }
            }}
          >
            {levels.map((level, index) => {
              const isCurrent = level === effectiveThinking
              const isHighlighted = index === highlighted
              return (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  data-option-index={index}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => { onPickThinking(level); onClose() }}
                  className={clsx(
                    'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-all',
                    isHighlighted
                      ? 'bg-accent/10 text-primary ring-1 ring-accent/30'
                      : isCurrent
                        ? 'bg-card font-medium text-accent'
                        : 'hover:bg-surface-hover/80 text-secondary hover:text-primary',
                  )}
                >
                  <span className="capitalize">{level}</span>
                  {isCurrent && <Check size={13} className="text-accent shrink-0" />}
                </button>
              )
            })}
          </div>

        </>
      )}
      {locked && (
        <div className="shrink-0 px-3 py-1.5 border-t border-border/60 text-[10px] text-muted bg-surface-hover/40">
          {t('quickChat.switchWhileBusyHint')}
        </div>
      )}
    </div>
  )
})
