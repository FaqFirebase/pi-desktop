import { ShieldCheck, ChevronDown, Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import type { PermissionMode } from '../../../shared/ipc-contracts'
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODE_OPTIONS } from './permission-mode'

interface PermissionSelectorProps {
  value: PermissionMode | null | undefined
  onChange: (mode: PermissionMode) => Promise<void> | void
  compact?: boolean
}

export function PermissionSelector({
  value,
  onChange,
  compact = false,
}: PermissionSelectorProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const mode = value ?? DEFAULT_PERMISSION_MODE
  const current = PERMISSION_MODE_OPTIONS.find((option) => option.value === mode) ?? PERMISSION_MODE_OPTIONS[1]

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const handleSelect = async (nextMode: PermissionMode) => {
    setSaving(true)
    try {
      await onChange(nextMode)
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
          'flex w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface text-left transition-colors hover:border-border-strong-hover',
          compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck size={compact ? 13 : 15} className="shrink-0 text-success" />
          <span className="min-w-0">
            <span className="block truncate text-primary">{current.label}</span>
            {!compact && (
              <span className="mt-0.5 block truncate text-xs text-dim">
                {current.description}
              </span>
            )}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={clsx('shrink-0 text-dim transition-transform', isOpen && 'rotate-180')}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-border-strong bg-app py-1 shadow-xl shadow-black/40">
          {PERMISSION_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={saving}
              onClick={() => handleSelect(option.value)}
              className="hover:bg-highlight flex w-full items-start gap-2 px-3 py-2 text-left transition-colors disabled:opacity-60"
            >
              <span className="mt-0.5 w-4 shrink-0">
                {option.value === mode && <Check size={13} className="text-success" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-primary">{option.label}</span>
                <span className="mt-0.5 block text-xs leading-4 text-dim">
                  {option.description}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
