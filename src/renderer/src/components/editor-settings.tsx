import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '../store'
import { isEditorId, resolvePreferredEditor, type DetectedEditor } from '../../../shared/editors'
import { SelectField, SettingsRow } from './settings-controls'

// The select value that stands for "System default" (saved as null).
const SYSTEM_DEFAULT_VALUE = ''

/**
 * Settings > Editor: the editor "Open in editor" uses, picked from the editors
 * found on this computer. A change saves at once. The saved value comes from
 * the store, so "Reset to defaults" also shows System default here.
 */
export function EditorSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const saved = useAppStore((state) => state.settings?.preferredEditor ?? null)
  const [detected, setDetected] = useState<DetectedEditor[] | null>(null)
  const [scanning, setScanning] = useState(false)

  const scan = useCallback(async (force: boolean) => {
    setScanning(true)
    try {
      setDetected(await window.piDesktop.editors.detect(force))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scan(false)
  }, [scan])

  const { editor, missing } = resolvePreferredEditor(saved, detected ?? [])
  const showMissing = detected !== null && missing

  const choose = async (value: string): Promise<void> => {
    const preferredEditor = isEditorId(value) ? value : null
    await window.piDesktop.settings.save({ preferredEditor })
    await useAppStore.getState().loadSettings()
  }

  return (
    <>
      <SettingsRow label={t('settings.editor.label')} description={t('settings.editor.description')}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SelectField value={editor?.id ?? SYSTEM_DEFAULT_VALUE} onChange={(value) => void choose(value)}>
              <option value={SYSTEM_DEFAULT_VALUE}>{t('settings.editor.systemDefault')}</option>
              {(detected ?? []).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.inTerminal
                    ? t('settings.editor.terminalOption', { name: candidate.name, tag: t('settings.editor.terminalTag') })
                    : candidate.name}
                </option>
              ))}
            </SelectField>
          </div>
          <button
            type="button"
            onClick={() => void scan(true)}
            disabled={scanning}
            title={t('settings.editor.rescan')}
            aria-label={t('settings.editor.rescan')}
            className="rounded-md p-1.5 text-dim hover:bg-highlight-strong hover:text-secondary disabled:opacity-50"
          >
            <RefreshCw size={14} className={scanning ? 'animate-spin' : undefined} />
          </button>
        </div>
      </SettingsRow>
      {showMissing && <div className="text-xs text-warning">{t('settings.editor.missingNote')}</div>}
    </>
  )
}
