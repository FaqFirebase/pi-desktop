import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronUp, Zap } from 'lucide-react'
import { clsx } from 'clsx'
import { useChatSession } from '../chat-session-context'
import { thinkingLevels } from '../utils/thinking-levels'
import type { ModelInfo } from '../../../shared/ipc-contracts'

interface ThinkingLevelSelectorProps {
  className?: string
}

/** Compact model-aware effort picker for the composer action rail. */
export function ThinkingLevelSelector(props: ThinkingLevelSelectorProps): React.JSX.Element {
  const { models } = useChatSession()
  return <SessionThinkingLevelSelector key={models.scopeKey} {...props} />
}

function SessionThinkingLevelSelector({ className }: ThinkingLevelSelectorProps): React.JSX.Element {
  const { t } = useTranslation()
  const { models: binding, settings, composer } = useChatSession()
  const listModels = binding.list
  const [isOpen, setIsOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelInfo[]>([])
  const [catalogResult, setCatalogResult] = useState<{ key: string; error: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  const ref = useRef<HTMLDivElement>(null)
  const provider = binding.pendingModel?.provider ?? binding.model?.provider ?? (binding.useDefaults ? settings.defaultProvider : undefined)
  const modelId = binding.pendingModel?.modelId ?? binding.model?.id ?? (binding.useDefaults ? settings.defaultModel : undefined)
  const model = catalog.find((candidate) => candidate.provider === provider && candidate.id === modelId)
    ?? (binding.model?.provider === provider && binding.model?.id === modelId ? binding.model : null)
  const modelKey = JSON.stringify([provider, modelId])
  const unresolved = Boolean(modelId && !model && catalogResult?.key !== modelKey)
  const loadError = !model && catalogResult?.key === modelKey && catalogResult.error
  const levels = thinkingLevels(model)
  const currentLevel = binding.pendingThinkingLevel ?? binding.thinkingLevel ?? (binding.useDefaults ? settings.defaultThinkingLevel : null)
  const effortLabel = currentLevel ? t('thinking.effortWithLevel', { level: currentLevel }) : t('thinking.effort')

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!isOpen || !unresolved) return
    let cancelled = false
    void listModels().then((available) => {
      if (cancelled) return
      setCatalog(available)
      setCatalogResult({ key: modelKey, error: false })
    }, () => {
      if (!cancelled) setCatalogResult({ key: modelKey, error: true })
    })
    return () => { cancelled = true }
  }, [isOpen, unresolved, modelKey, listModels])

  const select = async (level: string): Promise<void> => {
    if (binding.locked || pending.current || unresolved || loadError) return
    pending.current = true
    setSaving(true)
    setActionError(null)
    try {
      await binding.selectThinking(level)
      if (!mounted.current) return
      setIsOpen(false)
      composer.requestFocus()
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        disabled={binding.locked || saving}
        onClick={() => {
          if (!isOpen && loadError) setCatalogResult(null)
          setIsOpen((open) => !open)
        }}
        className={clsx(
          'flex h-7 items-center justify-center gap-1 rounded-l-none rounded-r-[7px] px-2 text-[11px] transition-colors active:scale-[0.98] @max-sm/composer:w-7 @max-sm/composer:gap-0 @max-sm/composer:px-0',
          isOpen ? 'bg-surface-hover text-primary' : 'text-dim hover:bg-surface-hover hover:text-secondary',
        )}
        title={effortLabel}
        aria-label={effortLabel}
        aria-expanded={isOpen}
      >
        <Zap size={12} className="shrink-0 text-accent-fg" />
        <span className="whitespace-nowrap @max-sm/composer:hidden">{currentLevel ?? t('thinking.effort')}</span>
        <ChevronUp
          size={10}
          className={clsx('shrink-0 transition-transform @max-lg/composer:hidden', isOpen && 'rotate-180')}
        />
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-40 overflow-hidden rounded-xl border border-border-strong bg-surface py-1 shadow-xl shadow-black/30 animate-fade-in">
          <div className="border-b border-border px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-faint">{t('thinking.effort')}</div>
          </div>
          {unresolved && <div className="px-3 py-2 text-xs text-dim">{t('common.loading')}</div>}
          {loadError && <div className="px-3 py-2 text-xs text-error">{t('models.selector.loadFailed')}</div>}
          {actionError && <div role="alert" className="px-3 py-2 text-xs text-error">{t('store.messages.error', { detail: actionError })}</div>}
          {!unresolved && !loadError && levels.map((level) => (
            <button
              key={level}
              type="button"
              disabled={binding.locked || saving}
              onClick={() => void select(level)}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-surface-hover',
                currentLevel === level ? 'text-primary' : 'text-muted',
              )}
            >
              {currentLevel === level ? <Check size={11} className="text-success" /> : <span className="w-[11px]" />}
              <span>{level}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
