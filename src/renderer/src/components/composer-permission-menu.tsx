import { useEffect, useRef, useState } from 'react'
import { ChevronUp, Check } from 'lucide-react'
import { clsx } from 'clsx'
import type { PermissionMode } from '../../../shared/ipc-contracts'
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_OPTIONS,
  getPermissionModeLabel,
  getPermissionModeDescription,
} from './permission-mode'

interface ComposerPermissionMenuProps {
  value: PermissionMode | null | undefined
  onChange: (mode: PermissionMode) => Promise<void> | void
}

/**
 * A compact, label-only permission-mode picker for the in-composer toolbar — a
 * shortcut for the same modes offered in the review panel. The current mode
 * shows as a plain label; the menu opens upward (the composer sits at the
 * bottom of the window). Selecting a mode applies it via `onChange`, the same
 * path the review panel uses.
 */
export function ComposerPermissionMenu({ value, onChange }: ComposerPermissionMenuProps): React.JSX.Element {
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
          'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
          isTrusted
            ? 'bg-warning/15 text-warning hover:bg-warning/35'
            : 'hover:bg-highlight-strong text-secondary hover:text-primary'
        )}
        title={getPermissionModeDescription(mode).replace(/\.$/, '')}
      >
        {getPermissionModeLabel(mode)}
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
          <div className="px-3 pb-0.5 pt-1 text-[11px] text-dim">Permissions</div>
          {PERMISSION_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={saving}
              onClick={() => handleSelect(option.value)}
              className="hover:bg-highlight flex w-full items-center justify-between gap-6 whitespace-nowrap px-3 py-1 text-left text-xs text-primary transition-colors disabled:opacity-60"
            >
              <span>{option.label}</span>
              {option.value === mode && <Check size={12} className="shrink-0 text-muted" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
