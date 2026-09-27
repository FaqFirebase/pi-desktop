import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  captureShortcut, formatShortcut, shortcutProblem, SHORTCUT_ACTIONS,
  type KeyboardShortcuts, type ShortcutAction, type ShortcutProblem,
} from '../../../shared/keyboard-shortcuts'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'

function actionLabel(action: ShortcutAction, t: TFunction): string {
  switch (action) {
    case 'diff': return t('chat.toolbar.diffViewer')
    case 'terminal': return t('chat.toolbar.terminal')
    case 'settings': return t('common.settings')
    case 'commandPalette': return t('settings.shortcuts.commandPalette')
    case 'modelSelector': return t('settings.shortcuts.modelSelector')
    case 'notes': return t('settings.shortcuts.notes')
    case 'commitPush': return t('settings.shortcuts.commitPush')
  }
}

export function ShortcutSettings({ value, onChange }: {
  value: KeyboardShortcuts
  onChange: (value: KeyboardShortcuts) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const platform = window.piDesktop.system.platform
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [captureError, setCaptureError] = useState<ShortcutProblem | null>(null)
  const problem = captureError ?? shortcutProblem(value, platform)

  return (
    <div className="space-y-3" data-shortcut-recorder>
      <p className="text-xs text-dim">{t('settings.shortcuts.description')}</p>
      {SHORTCUT_ACTIONS.map((action) => (
        <div key={action} className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={`shortcut-${action}`} className="text-sm text-secondary">{actionLabel(action, t)}</label>
          <div className="flex items-center gap-2">
            <input
              id={`shortcut-${action}`}
              readOnly
              value={recording === action ? t('settings.shortcuts.pressKeys')
                : value[action] ? formatShortcut(value[action], platform) : t('settings.shortcuts.disabled')}
              onFocus={() => { setRecording(action); setCaptureError(null) }}
              onBlur={() => setRecording(null)}
              onKeyDown={(event) => {
                if (event.key === 'Tab') return
                event.preventDefault()
                event.stopPropagation()
                if (event.key === 'Escape') { event.currentTarget.blur(); return }
                if (event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) return
                if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
                const binding = captureShortcut(event.nativeEvent, platform)
                if (!binding) { setCaptureError({ kind: 'invalid', action }); return }
                const next = { ...value, [action]: binding }
                const conflict = shortcutProblem(next, platform)
                setCaptureError(conflict)
                if (!conflict) { onChange(next); event.currentTarget.blur() }
              }}
              className="w-48 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
            />
            <button
              type="button"
              onClick={() => { onChange({ ...value, [action]: null }); setCaptureError(null) }}
              disabled={value[action] === null}
              aria-label={t('settings.shortcuts.disableAction', { action: actionLabel(action, t) })}
              className="text-xs text-muted hover:text-primary disabled:opacity-40"
            >{t('settings.shortcuts.disable')}</button>
          </div>
        </div>
      ))}
      {problem && (
        <p role="alert" className="text-xs text-error">
          {problem.kind === 'duplicate'
            ? t('settings.shortcuts.duplicate', { action: actionLabel(problem.action, t), other: actionLabel(problem.other, t) })
            : problem.kind === 'reserved' ? t('settings.shortcuts.reserved') : t('settings.shortcuts.invalid')}
        </p>
      )}
      <button
        type="button"
        onClick={() => { onChange({ ...DEFAULT_SETTINGS.shortcuts }); setCaptureError(null) }}
        className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
      >{t('settings.shortcuts.reset')}</button>
    </div>
  )
}
