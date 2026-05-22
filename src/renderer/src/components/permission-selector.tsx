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
          'flex w-full items-center justify-between gap-2 rounded-md border border-neutral-700 bg-neutral-900 text-left transition-colors hover:border-neutral-600',
          compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck size={compact ? 13 : 15} className="shrink-0 text-emerald-400" />
          <span className="min-w-0">
            <span className="block truncate text-neutral-100">{current.label}</span>
            {!compact && (
              <span className="mt-0.5 block truncate text-xs text-neutral-500">
                {current.description}
              </span>
            )}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={clsx('shrink-0 text-neutral-500 transition-transform', isOpen && 'rotate-180')}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-neutral-700 bg-neutral-950 py-1 shadow-xl shadow-black/40">
          {PERMISSION_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={saving}
              onClick={() => handleSelect(option.value)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-neutral-800 disabled:opacity-60"
            >
              <span className="mt-0.5 w-4 shrink-0">
                {option.value === mode && <Check size={13} className="text-emerald-400" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-neutral-100">{option.label}</span>
                <span className="mt-0.5 block text-xs leading-4 text-neutral-500">
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
