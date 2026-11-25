import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Trash2, Loader2, Check, Info, KeyRound } from 'lucide-react'
import type {
  VoiceStatus,
  VoiceProgressEvent,
} from '../../../shared/ipc-contracts'
import {
  VOICE_TRANSCRIBERS,
  normalizeVoiceServerSettings,
  voiceServerEndpoint,
  voiceServerReady,
  type VoiceServerSettings,
  type VoiceTranscriber,
} from '../../../shared/voice-server'
import type { VoiceModel, VoicePrecision } from '../../../shared/voice-models'
import {
  precisionForRuntime,
  resolveVoiceRuntime,
  VOICE_DEVICES,
  type VoiceDevice,
} from '../../../shared/voice-device'
import { probeGpu, type GpuProbe } from '../voice/gpu-probe'
import { formatIpcError } from '../utils/ipc-error'

const TAB_CLASS = 'rounded-md px-2 py-1 text-xs transition-colors'
const TAB_SELECTED_CLASS = 'bg-card text-primary ring-1 ring-inset ring-border-strong'
const TAB_IDLE_CLASS = 'text-dim hover:text-secondary'
const INPUT_CLASS =
  'min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none'
const BUTTON_CLASS =
  'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-dim hover:bg-highlight-strong hover:text-secondary disabled:opacity-50'
const SERVER_FIELDS = ['baseUrl', 'model', 'language', 'prompt'] as const

/**
 * Voice dictation settings: where speech becomes text (this computer or a
 * server the user chooses). On this computer: where the model runs (Auto, CPU
 * or GPU) and the model picker. The device decides which version of a model
 * to download: the GPU version (fp16) or the CPU version (int8). No model is
 * downloaded until the user installs one; there is no default. Each row
 * explains what the model is, how big it is, and which languages it covers.
 */
export function VoiceSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [gpu, setGpu] = useState<GpuProbe | null>(null)
  const [progress, setProgress] = useState<VoiceProgressEvent | null>(null)
  const [busyModel, setBusyModel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const next = await window.piDesktop.voice.status()
    setStatus(next)
  }, [])

  useEffect(() => {
    void refresh()
    void probeGpu().then(setGpu)
    const off = window.piDesktop.voice.onProgress((event) => {
      setProgress(event.phase === 'downloading' ? event : null)
      if (event.phase === 'error') setError(event.error ?? 'download failed')
    })
    return off
  }, [refresh])

  const runtime = status && gpu ? resolveVoiceRuntime(status.device, gpu.available) : null
  const precision: VoicePrecision = precisionForRuntime(runtime ?? 'cpu')

  const install = useCallback(
    async (model: VoiceModel) => {
      setError(null)
      setBusyModel(model.id)
      try {
        await window.piDesktop.voice.install({ modelId: model.id, precision })
        await window.piDesktop.voice.select({ modelId: model.id, precision })
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyModel(null)
        setProgress(null)
      }
    },
    [precision, refresh],
  )

  const remove = useCallback(
    async (model: VoiceModel) => {
      setError(null)
      setBusyModel(model.id)
      try {
        await window.piDesktop.voice.remove(model.id)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyModel(null)
      }
    },
    [refresh],
  )

  const setTranscriber = useCallback(
    async (transcriber: VoiceTranscriber) => {
      setError(null)
      try {
        await window.piDesktop.settings.save({ voiceTranscriber: transcriber })
        await refresh()
      } catch (err) {
        setError(formatIpcError(err))
      }
    },
    [refresh],
  )

  const setDevice = useCallback(
    async (device: VoiceDevice) => {
      setError(null)
      try {
        await window.piDesktop.settings.save({ voiceDevice: device })
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh],
  )

  const select = useCallback(
    async (model: VoiceModel, modelPrecision: VoicePrecision) => {
      await window.piDesktop.voice.select({ modelId: model.id, precision: modelPrecision })
      await refresh()
    },
    [refresh],
  )

  if (!status || !gpu || !runtime) {
    return <div className="text-sm text-dim">{t('common.loading')}</div>
  }

  const errorNote = error && (
    <div className="rounded-md border border-error-bg bg-error-bg px-2 py-1 text-xs text-error">
      {error}
    </div>
  )

  const transcriberTabs = (
    <div className="flex items-center gap-2">
      <span className="text-sm text-primary">{t('settings.voice.transcribe')}</span>
      <div className="flex gap-1" role="tablist" aria-label={t('settings.voice.transcribe')}>
        {VOICE_TRANSCRIBERS.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={status.transcriber === option}
            onClick={() => void setTranscriber(option)}
            className={`${TAB_CLASS} ${status.transcriber === option ? TAB_SELECTED_CLASS : TAB_IDLE_CLASS}`}
          >
            {t(`settings.voice.transcriber.${option}`)}
          </button>
        ))}
      </div>
    </div>
  )

  if (status.transcriber === 'server') {
    return (
      <div className="space-y-4">
        {transcriberTabs}
        {errorNote}
        <ServerTranscriberSettings status={status} onStatus={setStatus} onError={setError} onSaved={refresh} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {transcriberTabs}
      <p className="text-xs text-dim">{t('settings.voice.intro')}</p>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-primary">{t('settings.voice.runOn')}</span>
          <div className="flex gap-1" role="tablist" aria-label={t('settings.voice.runOn')}>
            {VOICE_DEVICES.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={status.device === option}
                onClick={() => void setDevice(option)}
                className={`${TAB_CLASS} ${status.device === option ? TAB_SELECTED_CLASS : TAB_IDLE_CLASS}`}
              >
                {t(`settings.voice.device.${option}`)}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-dim">
          {runtime === 'gpu'
            ? t('settings.voice.runtimeGpu', { name: gpu.name ?? t('settings.voice.gpuUnnamed') })
            : status.device === 'cpu'
              ? t('settings.voice.runtimeCpu')
              : t('settings.voice.runtimeCpuNoGpu')}
        </p>
        {status.restartRequired && (
          <p className="text-xs text-accent">{t('settings.voice.restartRequired')}</p>
        )}
      </div>

      {errorNote}

      <div className="space-y-2">
        {status.catalog.map((model) => {
          const installedEntry = status.installed.find((m) => m.id === model.id)
          const isSelected = status.selectedModel === model.id
          const isBusy = busyModel === model.id
          const sizeMb = model.approxSizeMb[precision]
          return (
            <div
              key={model.id}
              className={`rounded-lg border p-3 transition-colors ${
                isSelected ? 'border-accent bg-card/60' : 'border-border bg-surface/40'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">
                      {t(`voice.models.${model.id}.name` as never)}
                    </span>
                    {isSelected && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-accent">
                        <Check size={11} /> {t('settings.voice.selected')}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-dim">{t(model.noteKey as never)}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-faint">
                    <span>
                      {model.languages === 'multi'
                        ? t('settings.voice.multilingual')
                        : t('settings.voice.englishOnly')}
                    </span>
                    <span>{t('settings.voice.sizeMb', { mb: sizeMb })}</span>
                    <span>{model.license}</span>
                    {installedEntry && (
                      <span>{t(`settings.voice.precision.${installedEntry.precision}`)}</span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {installedEntry ? (
                    <>
                      {installedEntry.precision !== precision && (
                        <button
                          type="button"
                          onClick={() => void install(model)}
                          disabled={isBusy || busyModel !== null}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-dim hover:bg-highlight-strong hover:text-secondary disabled:opacity-50"
                        >
                          {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                          {t('settings.voice.getVersion', {
                            version: t(`settings.voice.precision.${precision}`),
                          })}
                        </button>
                      )}
                      {!isSelected && (
                        <button
                          type="button"
                          onClick={() => void select(model, installedEntry.precision)}
                          className="rounded-md px-2 py-1 text-xs text-dim hover:bg-highlight-strong hover:text-secondary"
                        >
                          {t('settings.voice.use')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void remove(model)}
                        disabled={isBusy}
                        className="flex items-center justify-center rounded-md p-1.5 text-dim hover:bg-highlight-strong hover:text-error disabled:opacity-50"
                        title={t('settings.voice.remove')}
                        aria-label={t('settings.voice.remove')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void install(model)}
                      disabled={isBusy || busyModel !== null}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-dim hover:bg-highlight-strong hover:text-secondary disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                      {t('settings.voice.install')}
                    </button>
                  )}
                </div>
              </div>

              {isBusy && progress?.modelId === model.id && progress.progress.totalFiles > 0 && (
                <div className="mt-2">
                  <div className="h-1 w-full overflow-hidden rounded bg-card">
                    <div
                      className="h-full bg-accent transition-all"
                      style={{
                        width: `${Math.round(
                          (progress.progress.completedFiles / progress.progress.totalFiles) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-faint">
                    {t('settings.voice.downloading', {
                      done: progress.progress.completedFiles,
                      total: progress.progress.totalFiles,
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The user's OpenAI-compatible transcription server: address, model, optional
 * language and prompt, and an optional API key. The key is saved by the main
 * process in its own file and never comes back to the page.
 */
function ServerTranscriberSettings({ status, onStatus, onError, onSaved }: {
  status: VoiceStatus
  onStatus: (status: VoiceStatus) => void
  onError: (error: string | null) => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<VoiceServerSettings>(status.server)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const entered = normalizeVoiceServerSettings(draft)
  const changed = SERVER_FIELDS.some((field) => entered[field] !== status.server[field])
  const addressInvalid = entered.baseUrl !== '' && voiceServerEndpoint(entered.baseUrl) === null

  const run = async (work: () => Promise<void>) => {
    onError(null)
    setBusy(true)
    try {
      await work()
    } catch (err) {
      onError(formatIpcError(err))
    } finally {
      setBusy(false)
    }
  }

  const saveServer = () => run(async () => {
    await window.piDesktop.settings.save({ voiceServer: entered })
    setDraft(entered)
    await onSaved()
  })

  const saveKey = () => run(async () => {
    const result = await window.piDesktop.voice.saveServerKey(keyDraft)
    if (!result.ok) {
      onError(t('settings.voice.server.keyInvalid'))
      return
    }
    setKeyDraft('')
    onStatus(result.status)
  })

  const fieldLabels: Record<typeof SERVER_FIELDS[number], string> = {
    baseUrl: t('settings.voice.server.address'),
    model: t('settings.voice.server.model'),
    language: t('settings.voice.server.language'),
    prompt: t('settings.voice.server.prompt'),
  }
  const fieldPlaceholders: Record<typeof SERVER_FIELDS[number], string> = {
    baseUrl: t('settings.voice.server.addressPlaceholder'),
    model: t('settings.voice.server.modelPlaceholder'),
    language: t('settings.voice.server.languagePlaceholder'),
    prompt: t('settings.voice.server.promptPlaceholder'),
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-dim">{t('settings.voice.server.intro')}</p>

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          void saveServer()
        }}
      >
        {SERVER_FIELDS.map((field) => (
          <label key={field} className="flex items-center gap-2">
            <span className="flex w-32 shrink-0 items-center gap-1 text-xs text-secondary">
              {fieldLabels[field]}
              {field === 'baseUrl' && (
                <span title={t('settings.voice.server.addressTip')}>
                  <Info size={12} className="text-dim" aria-label={t('settings.voice.server.addressTip')} />
                </span>
              )}
            </span>
            <input
              type="text"
              value={draft[field]}
              onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              placeholder={fieldPlaceholders[field]}
              aria-invalid={field === 'baseUrl' && addressInvalid}
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
          </label>
        ))}
        {addressInvalid && <p className="text-xs text-error">{t('settings.voice.server.addressInvalid')}</p>}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-dim">
            {voiceServerReady(status.server) ? t('settings.voice.server.ready') : t('settings.voice.server.notReady')}
          </span>
          <button type="submit" disabled={busy || !changed || addressInvalid} className={BUTTON_CLASS}>
            {t('settings.voice.server.save')}
          </button>
        </div>
      </form>

      <div className="space-y-2">
        <div className="text-sm text-primary">{t('settings.voice.server.key')}</div>
        {status.serverKeySaved ? (
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1 text-xs text-secondary">
              <Check size={13} /> {t('settings.voice.server.keySaved')}
            </span>
            <button
              type="button"
              onClick={() => void run(async () => onStatus(await window.piDesktop.voice.clearServerKey()))}
              disabled={busy}
              className={BUTTON_CLASS}
            >
              <Trash2 size={13} /> {t('settings.voice.server.keyRemove')}
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
              placeholder={t('settings.voice.server.keyPlaceholder')}
              aria-label={t('settings.voice.server.key')}
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            <button type="submit" disabled={busy || keyDraft.trim() === ''} className={BUTTON_CLASS}>
              <KeyRound size={13} /> {t('settings.voice.server.keySave')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
