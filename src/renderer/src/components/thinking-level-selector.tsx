import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Zap } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import { thinkingLevels } from '../utils/thinking-levels'

interface ThinkingLevelSelectorProps {
  className?: string
}

/** Compact model-aware effort picker for the composer action rail. */
export function ThinkingLevelSelector({ className }: ThinkingLevelSelectorProps): React.JSX.Element {
  const { t } = useTranslation()
  const sessionState = useAppStore((state) => state.sessionState)
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const piStatus = useAppStore((state) => state.piStatus)
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const levels = thinkingLevels(sessionState?.model)
  const currentLevel = sessionState?.thinkingLevel ?? 'medium'

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  if (piStatus !== 'running') return <></>

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className={clsx(
          'flex h-7 w-7 items-center justify-center rounded-l-none rounded-r-[7px] text-[11px] transition-colors active:scale-[0.98]',
          isOpen ? 'bg-surface-hover text-primary' : 'text-dim hover:bg-surface-hover hover:text-secondary',
        )}
        title={t('thinking.effortWithLevel', { level: currentLevel })}
        aria-label={t('thinking.effortWithLevel', { level: currentLevel })}
        aria-expanded={isOpen}
      >
        {/* Icon only: the level lives in the tooltip and the open menu. */}
        <Zap size={12} className="shrink-0 text-accent-fg" />
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-40 overflow-hidden rounded-xl border border-border-strong bg-surface py-1 shadow-xl shadow-black/30 animate-fade-in">
          <div className="border-b border-border px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-faint">{t('thinking.effort')}</div>
            <div className="mt-0.5 text-xs text-dim">{t('thinking.modelAwareDepth')}</div>
          </div>
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => {
                void setThinkingLevel(level)
                setIsOpen(false)
              }}
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
