import { useEffect, useRef, useState } from 'react'
import { Check, ChevronUp, Zap } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'

interface ThinkingLevelSelectorProps {
  className?: string
}

/** Compact model-aware effort picker for the composer action rail. */
export function ThinkingLevelSelector({ className }: ThinkingLevelSelectorProps): React.JSX.Element {
  const sessionState = useAppStore((state) => state.sessionState)
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const piStatus = useAppStore((state) => state.piStatus)
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const modelEfforts = sessionState?.model?.thinking?.efforts?.filter(
    (level) => typeof level === 'string' && level.length > 0,
  )
  const levels =
    modelEfforts && modelEfforts.length > 0
      ? ['off', ...modelEfforts.filter((level) => level !== 'off')]
      : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
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
          'flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors active:scale-[0.98]',
          isOpen ? 'bg-surface-hover text-primary' : 'text-dim hover:bg-surface-hover hover:text-secondary',
        )}
        title={`Thinking effort: ${currentLevel}`}
        aria-label={`Thinking effort: ${currentLevel}`}
        aria-expanded={isOpen}
      >
        <Zap size={11} className="shrink-0 text-accent-fg" />
        <span>{currentLevel}</span>
        <ChevronUp size={10} className={clsx('shrink-0 transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-40 overflow-hidden rounded-xl border border-border-strong bg-surface py-1 shadow-xl shadow-black/30 animate-fade-in">
          <div className="border-b border-border px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-faint">Effort</div>
            <div className="mt-0.5 text-xs text-dim">Model-aware thinking depth</div>
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
