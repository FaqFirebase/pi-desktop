import { useEffect, useRef, useState } from 'react'
import { ChevronUp, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import type { PermissionMode } from '../../../shared/ipc-contracts'
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_OPTIONS,
  PERMISSION_MODE_LABEL_KEYS,
  getPermissionModeDescription,
} from './permission-mode'
import { useAppStore } from '../store'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../../shared/agent-engine-label'

// Labels for a composer too narrow for the full ones. Kept beside their only
// t() call so the i18n extractor can resolve them.
const PERMISSION_MODE_SHORT_LABEL_KEYS = {
  'plan-readonly': 'permissionMode.plan-readonly.shortLabel',
  'ask-edits': 'permissionMode.ask-edits.shortLabel',
  'ask-commands': 'permissionMode.ask-commands.shortLabel',
  trusted: 'permissionMode.trusted.shortLabel',
} as const satisfies Record<PermissionMode, string>

interface ComposerPermissionMenuProps {
  value: PermissionMode | null | undefined
  onChange: (mode: PermissionMode) => Promise<void> | void
}

/**
 * Compact permission-mode picker for the composer toolbar (same modes as review).
 */
export function ComposerPermissionMenu({ value, onChange }: ComposerPermissionMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const engineLabel = useAppStore((state) => agentEngineLabel(state.piEngine) ?? DEFAULT_AGENT_ENGINE_LABEL)
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
          'flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-xs transition-colors',
          isTrusted
            ? 'bg-warning/15 text-warning hover:bg-warning/35'
            : 'hover:bg-highlight-strong text-secondary hover:text-primary'
        )}
        title={getPermissionModeDescription(t, mode, engineLabel).replace(/\.$/, '')}
      >
        {/* A narrow composer (the diff or file pane open) takes the short label, so the toolbar stays on one line. */}
        <span className="@max-lg/composer:hidden">{t(PERMISSION_MODE_LABEL_KEYS[mode])}</span>
        <span className="hidden @max-lg/composer:inline">{t(PERMISSION_MODE_SHORT_LABEL_KEYS[mode])}</span>
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
