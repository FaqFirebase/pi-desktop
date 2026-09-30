import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  captureShortcut, duplicateShortcutOwner, formatShortcut, shortcutProblem, SHORTCUT_ACTIONS,
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
    case 'sidebar': return t('settings.shortcuts.sidebar')
    case 'files': return t('chat.toolbar.fileTree')
    case 'review': return t('chat.toolbar.reviewPanel')
    case 'newSession': return t('common.newSession')
    case 'previousProject': return t('settings.shortcuts.previousProject')
    case 'nextProject': return t('settings.shortcuts.nextProject')
    case 'previousSession': return t('settings.shortcuts.previousSession')
    case 'nextSession': return t('settings.shortcuts.nextSession')
  }
}

function problemText(problem: ShortcutProblem, t: TFunction): string {
  switch (problem.kind) {
    case 'duplicate': return t('settings.shortcuts.duplicate', { action: actionLabel(problem.action, t), other: actionLabel(problem.other, t) })
    case 'reserved': return t('settings.shortcuts.reserved')
    case 'invalid': return t('settings.shortcuts.invalid')
  }
}

/** A combination the recorder refused for `action`; `binding` is null when the keys form no shortcut. */
interface CaptureRefusal {
  action: ShortcutAction
  binding: string | null
  problem: ShortcutProblem
}

function refusalText({ action, binding, problem }: CaptureRefusal, t: TFunction, platform: string): string {
  const owner = duplicateShortcutOwner(problem, action)
  return owner && binding
    ? t('settings.shortcuts.inUse', { shortcut: formatShortcut(binding, platform), action: actionLabel(owner, t) })
    : problemText(problem, t)
}

export function ShortcutSettings({ value, onChange }: {
  value: KeyboardShortcuts
  onChange: (value: KeyboardShortcuts) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const platform = window.piDesktop.system.platform
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [refusal, setRefusal] = useState<CaptureRefusal | null>(null)
  const problem = shortcutProblem(value, platform)

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
              aria-invalid={refusal?.action === action}
              aria-describedby={refusal?.action === action ? `shortcut-${action}-refusal` : undefined}
              onFocus={() => { setRecording(action); setRefusal(null) }}
              onBlur={() => setRecording(null)}
              onKeyDown={(event) => {
                if (event.key === 'Tab') return
                event.preventDefault()
                event.stopPropagation()
                if (event.key === 'Escape') { setRefusal(null); event.currentTarget.blur(); return }
                if (event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) return
                if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
                const binding = captureShortcut(event.nativeEvent, platform)
                if (!binding) { setRefusal({ action, binding, problem: { kind: 'invalid', action } }); return }
                const next = { ...value, [action]: binding }
                const conflict = shortcutProblem(next, platform)
                setRefusal(conflict && { action, binding, problem: conflict })
                if (!conflict) { onChange(next); event.currentTarget.blur() }
              }}
              className="w-48 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
            />
            <button
              type="button"
              onClick={() => { onChange({ ...value, [action]: null }); setRefusal(null) }}
              disabled={value[action] === null}
              aria-label={t('settings.shortcuts.disableAction', { action: actionLabel(action, t) })}
              className="text-xs text-muted hover:text-primary disabled:opacity-40"
            >{t('settings.shortcuts.disable')}</button>
          </div>
          {refusal?.action === action && (
            <p id={`shortcut-${action}-refusal`} role="alert" className="basis-full text-right text-xs text-error">
              {refusalText(refusal, t, platform)}
            </p>
          )}
        </div>
      ))}
      {problem && <p role="alert" className="text-xs text-error">{problemText(problem, t)}</p>}
      <button
        type="button"
        onClick={() => { onChange({ ...DEFAULT_SETTINGS.shortcuts }); setRefusal(null) }}
        className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
      >{t('settings.shortcuts.reset')}</button>
    </div>
  )
}
