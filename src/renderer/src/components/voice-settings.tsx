import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Trash2, Loader2, Check } from 'lucide-react'
import type {
  VoiceStatus,
  VoiceProgressEvent,
} from '../../../shared/ipc-contracts'
import type { VoiceModel, VoicePrecision } from '../../../shared/voice-models'
import {
  precisionForRuntime,
  resolveVoiceRuntime,
  VOICE_DEVICES,
  type VoiceDevice,
} from '../../../shared/voice-device'
import { probeGpu, type GpuProbe } from '../voice/gpu-probe'

/**
 * Voice dictation settings: where the model runs (Auto, CPU or GPU) and the
 * model picker. The device decides which version of a model to download: the
 * GPU version (fp16) or the CPU version (int8). No model is downloaded until
 * the user installs one; there is no default. Each row explains what the model
 * is, how big it is, and which languages it covers.
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

  return (
    <div className="space-y-4">
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
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  status.device === option
                    ? 'bg-card text-primary ring-1 ring-inset ring-border-strong'
                    : 'text-dim hover:text-secondary'
                }`}
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

      {error && (
        <div className="rounded-md border border-error-bg bg-error-bg px-2 py-1 text-xs text-error">
          {error}
        </div>
      )}

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
