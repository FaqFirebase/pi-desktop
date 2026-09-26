import { useEffect, useRef, useState } from 'react'
import { ChevronUp, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import type { PermissionMode } from '../../../shared/ipc-contracts'
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_OPTIONS,
  PERMISSION_MODE_LABEL_KEYS,
  PERMISSION_MODE_DESCRIPTION_KEYS,
} from './permission-mode'

interface ComposerPermissionMenuProps {
  value: PermissionMode | null | undefined
  onChange: (mode: PermissionMode) => Promise<void> | void
}

/**
 * Compact permission-mode picker for the composer toolbar (same modes as review).
 */
export function ComposerPermissionMenu({ value, onChange }: ComposerPermissionMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const mode = value ?? DEFAULT_PERMISSION_MODE
  const isTrusted = mode === 'trusted'

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const handleSelect = async (next: PermissionMode): Promise<void> => {
    setSaving(true)
    try {
      await onChange(next)
      setIsOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className={clsx(
          'flex h-7 items-center gap-1 rounded-lg px-2 text-xs transition-colors',
          isTrusted
            ? 'bg-warning/15 text-warning hover:bg-warning/35'
            : 'hover:bg-highlight-strong text-secondary hover:text-primary'
        )}
        title={t(PERMISSION_MODE_DESCRIPTION_KEYS[mode]).replace(/\.$/, '')}
      >
        {t(PERMISSION_MODE_LABEL_KEYS[mode])}
        <ChevronUp
          size={12}
          className={clsx(
            'transition-transform',
            isTrusted ? 'text-warning/70' : 'text-dim',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[180px] rounded-lg border border-border-strong bg-app py-1 shadow-xl shadow-black/40">
          <div className="px-3 pb-0.5 pt-1 text-[11px] text-dim">{t('composer.permissionMenu.title')}</div>
          {PERMISSION_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={saving}
              onClick={() => handleSelect(option.value)}
              className="hover:bg-highlight flex w-full items-center justify-between gap-6 whitespace-nowrap px-3 py-1 text-left text-xs text-primary transition-colors disabled:opacity-60"
            >
              <span>{t(PERMISSION_MODE_LABEL_KEYS[option.value])}</span>
              {option.value === mode && <Check size={12} className="shrink-0 text-muted" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
