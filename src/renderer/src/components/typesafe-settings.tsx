import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, ExternalLink, KeyRound, Loader2, Trash2 } from 'lucide-react'
import type { TypeSafeStatus } from '../../../shared/ipc-contracts'
import { TYPESAFE_LINKS } from '../../../shared/typesafe'
import { formatIpcError } from '../utils/ipc-error'

type BusyAction = 'save-key' | 'clear-key' | 'install-skill' | 'remove-skill'

const BUTTON_CLASS =
  'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-dim hover:bg-highlight-strong hover:text-secondary disabled:opacity-50'

/**
 * TypeSafe (Jev) settings: a saved API key that Pi and OMP receive on
 * start, the agent skill that teaches them to use it, and links to the docs.
 * Pi Desktop itself never calls TypeSafe.
 */
export function TypeSafeSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<TypeSafeStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.piDesktop.typesafe.status().then(setStatus)
  }, [])

  const run = useCallback(async (action: BusyAction, work: () => Promise<TypeSafeStatus | null>) => {
    setError(null)
    setBusy(action)
    try {
      const next = await work()
      if (next) setStatus(next)
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const saveKey = useCallback(
    () =>
      run('save-key', async () => {
        const result = await window.piDesktop.typesafe.saveKey(keyDraft)
        if (!result.ok) {
          setError(t('settings.typesafe.apiKey.invalid'))
          return null
        }
        setKeyDraft('')
        return result.status
      }),
    [keyDraft, run, t],
  )

  if (!status) {
    return <div className="text-sm text-dim">{t('common.loading')}</div>
  }

  const { skill } = status
  const skillIsCurrent = skill.state === 'installed' && skill.installedVersion === skill.pinnedVersion

  return (
    <div className="space-y-4">
      <p className="text-xs text-dim">{t('settings.typesafe.intro')}</p>

      {error && (
        <div className="rounded-md border border-error-bg bg-error-bg px-2 py-1 text-xs text-error">{error}</div>
      )}

      <div className="space-y-2">
        <div className="text-sm text-primary">{t('settings.typesafe.apiKey.label')}</div>

        {status.savedKey ? (
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1 text-xs text-secondary">
              <Check size={13} /> {t('settings.typesafe.apiKey.saved')}
            </span>
            <button
              type="button"
              onClick={() => void run('clear-key', () => window.piDesktop.typesafe.clearKey())}
              disabled={busy !== null}
              className={BUTTON_CLASS}
            >
              <Trash2 size={13} /> {t('settings.typesafe.apiKey.remove')}
            </button>
          </div>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void saveKey()
            }}
          >
            <input
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder={t('settings.typesafe.apiKey.placeholder')}
              aria-label={t('settings.typesafe.apiKey.label')}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
            />
            <button type="submit" disabled={busy !== null || keyDraft.trim() === ''} className={BUTTON_CLASS}>
              {busy === 'save-key' ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
              {t('settings.typesafe.apiKey.save')}
            </button>
          </form>
        )}

        {status.environmentKey && (
          <p className="text-xs text-dim">{t('settings.typesafe.apiKey.environment')}</p>
        )}
        <p className="text-[11px] text-faint">{t('settings.typesafe.apiKey.nextSession')}</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-primary">{t('settings.typesafe.skill.label')}</div>
            <div className="text-xs text-dim">
              {skill.state === 'installed'
                ? t('settings.typesafe.skill.installed', { version: skill.installedVersion })
                : skill.state === 'installed-elsewhere'
                  ? t('settings.typesafe.skill.installedElsewhere')
                  : t('settings.typesafe.skill.notInstalled')}
            </div>
            <div className="mt-0.5 break-all text-[11px] text-faint">
              {t('settings.typesafe.skill.location', { directory: skill.directory })}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {skill.state !== 'installed-elsewhere' && !skillIsCurrent && (
              <button
                type="button"
                onClick={() => void run('install-skill', () => window.piDesktop.typesafe.installSkill())}
                disabled={busy !== null}
                className={BUTTON_CLASS}
              >
                {busy === 'install-skill' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                {skill.state === 'installed'
                  ? t('settings.typesafe.skill.update', { version: skill.pinnedVersion })
                  : t('settings.typesafe.skill.install')}
              </button>
            )}
            {skill.state === 'installed' && (
              <button
                type="button"
                onClick={() => void run('remove-skill', () => window.piDesktop.typesafe.removeSkill())}
                disabled={busy !== null}
                className="flex items-center justify-center rounded-md p-1.5 text-dim hover:bg-highlight-strong hover:text-error disabled:opacity-50"
                title={t('settings.typesafe.skill.remove')}
                aria-label={t('settings.typesafe.skill.remove')}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <DocLink url={TYPESAFE_LINKS.apiKeys} label={t('settings.typesafe.links.apiKeys')} />
        <DocLink url={TYPESAFE_LINKS.introduction} label={t('settings.typesafe.links.introduction')} />
        <DocLink url={TYPESAFE_LINKS.agentSkill} label={t('settings.typesafe.links.agentSkill')} />
      </div>
    </div>
  )
}

function DocLink({ url, label }: { url: string; label: string }): React.JSX.Element {
  return (
    <button type="button" onClick={() => void window.piDesktop.system.openExternal(url)} className={BUTTON_CLASS}>
      <ExternalLink size={13} /> {label}
    </button>
  )
}
