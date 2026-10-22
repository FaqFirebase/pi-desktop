import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Link2, Loader2, RefreshCw, Unlink, X } from 'lucide-react'
import type { DetectedRelay, RelayStatus } from '../../../shared/ipc-contracts'
import { formatIpcError } from '../utils/ipc-error'
import { relayConnectionLabel } from '../utils/relay-connection-label'

const BUTTON_CLASS =
  'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-dim hover:bg-highlight-strong hover:text-secondary disabled:opacity-50'
const FIELD_CLASS =
  'w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-primary outline-none focus:border-border-strong'

type BusyAction = 'url' | 'pair' | 'unpair' | 'rooms'

/**
 * Remote Pi relay settings: point this desktop at a relay, pair with a Pi on
 * another machine, and see the sessions that Pi is running.
 */
export function RelaySettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<RelayStatus | null>(null)
  const [urlDraft, setUrlDraft] = useState('')
  const [pairDraft, setPairDraft] = useState('')
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [detected, setDetected] = useState<DetectedRelay | null>(null)

  useEffect(() => {
    void window.piDesktop.relay.status().then((next) => {
      setStatus(next)
      setUrlDraft(next.settings.url ?? '')
    })
  }, [])

  useEffect(() => window.piDesktop.relay.onStatus(setStatus), [])

  // Offer what the Pi on this machine already uses. Detection never writes, so
  // opening Settings cannot repoint a relay the user did not choose here.
  useEffect(() => {
    void window.piDesktop.relay.detectUrl().then(setDetected)
  }, [])

  const run = useCallback(async (action: BusyAction, work: () => Promise<RelayStatus | null>) => {
    setError(null)
    setNotice(null)
    setBusy(action)
    try {
      const next = await work()
      if (next) {
        setStatus(next)
        setUrlDraft(next.settings.url ?? '')
      }
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const saveUrl = useCallback(
    () => run('url', () => window.piDesktop.relay.setUrl(urlDraft.trim() || null)),
    [run, urlDraft],
  )

  const pair = useCallback(
    () =>
      run('pair', async () => {
        await window.piDesktop.relay.pair(pairDraft.trim())
        setPairDraft('')
        setNotice(t('settings.relay.pair.success'))
        return window.piDesktop.relay.status()
      }),
    [run, pairDraft, t],
  )

  const unpair = useCallback(
    () => run('unpair', () => window.piDesktop.relay.unpair()),
    [run],
  )

  const refreshRooms = useCallback(
    () =>
      run('rooms', async () => {
        await window.piDesktop.relay.listRooms()
        return window.piDesktop.relay.status()
      }),
    [run],
  )

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-xs text-dim">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  const { settings, connection } = status
  const paired = settings.pairedAgent
  const connected = connection.status === 'connected' || connection.status === 'paired'

  return (
    <div className="space-y-4">
      <p className="text-xs text-dim">{t('settings.relay.intro')}</p>

      <div className="flex flex-col gap-2">
        <label htmlFor="relay-url" className="text-sm text-primary">
          {t('settings.relay.url.label')}
        </label>
        <div className="text-xs text-dim">{t('settings.relay.url.description')}</div>
        <div className="flex items-center gap-2">
          <input
            id="relay-url"
            className={FIELD_CLASS}
            value={urlDraft}
            placeholder="http://192.168.1.223:3000"
            onChange={(event) => setUrlDraft(event.target.value)}
            spellCheck={false}
          />
          <button type="button" className={BUTTON_CLASS} onClick={() => void saveUrl()} disabled={busy !== null}>
            {busy === 'url' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            {t('settings.relay.url.save')}
          </button>
        </div>
        {detected && detected.url !== settings.url && (
          <button
            type="button"
            className="self-start text-left text-xs text-accent hover:underline"
            onClick={() => setUrlDraft(detected.url)}
          >
            {t('settings.relay.url.detected', { url: detected.url })}
          </button>
        )}
        <div className="flex items-center gap-1 text-xs">
          <span
            aria-hidden
            className={connected ? 'text-success' : 'text-dim'}
            title={connection.status}
          >
            ●
          </span>
          <span className="text-dim">{relayConnectionLabel(connection.status, t)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-sm text-primary">{t('settings.relay.pair.label')}</div>
        <div className="text-xs text-dim">{t('settings.relay.pair.description')}</div>
        {paired ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1">
            <div className="flex flex-col">
              <span className="text-xs text-primary">{paired.agentName}</span>
              <span className="font-mono text-[10px] text-dim">{paired.pubkey.slice(0, 16)}…</span>
            </div>
            <button type="button" className={BUTTON_CLASS} onClick={() => void unpair()} disabled={busy !== null}>
              {busy === 'unpair' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
              {t('settings.relay.pair.unpair')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              className={FIELD_CLASS}
              value={pairDraft}
              placeholder="remotepi://pair?..."
              onChange={(event) => setPairDraft(event.target.value)}
              spellCheck={false}
            />
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => void pair()}
              disabled={busy !== null || !pairDraft.trim()}
            >
              {busy === 'pair' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
              {t('settings.relay.pair.pair')}
            </button>
          </div>
        )}
        <div className="text-xs text-dim">{t('settings.relay.pair.howTo')}</div>
      </div>

      {paired && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-sm text-primary">{t('settings.relay.sessions.label')}</div>
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => void refreshRooms()}
              disabled={busy !== null}
            >
              <RefreshCw className="h-3 w-3" />
              {t('settings.relay.sessions.refresh')}
            </button>
          </div>
          {connection.rooms.length === 0 ? (
            <div className="text-xs text-dim">{t('settings.relay.sessions.empty')}</div>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {connection.rooms.map((room) => (
                <li key={room.room_id} className="flex items-center justify-between gap-2 px-2 py-1">
                  <span className="text-xs text-primary">{room.name}</span>
                  <span className="truncate font-mono text-[10px] text-dim">{room.cwd}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {notice && (
        <div className="flex items-center gap-1 text-xs text-success">
          <Check className="h-3 w-3" />
          {notice}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1 text-xs text-danger">
          <X className="h-3 w-3" />
          {error}
        </div>
      )}
    </div>
  )
}
