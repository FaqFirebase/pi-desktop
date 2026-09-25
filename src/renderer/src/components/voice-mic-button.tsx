import { useTranslation } from 'react-i18next'
import { Mic, Square, Loader2 } from 'lucide-react'
import { useAppStore } from '../store'
import { useVoiceDictation, type VoiceDictationHandlers } from '../voice/use-voice-dictation'
import { VOICE_NEEDS_GPU_ERROR } from '../voice/voice-worker-protocol'

/**
 * Microphone button for the composer. Click to record; a running transcript
 * appears while you speak and it auto-stops after a short silence (click again
 * to stop sooner). When no model is installed yet, the button opens Settings
 * where the user picks one. It never sends the message.
 */
export function VoiceMicButton({
  handlers,
  disabled,
}: {
  handlers: VoiceDictationHandlers
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  const { phase, ready, error, toggle } = useVoiceDictation(handlers)

  const baseClass =
    'flex items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-50'

  if (!ready) {
    return (
      <button
        type="button"
        onClick={() => setCurrentView('settings')}
        disabled={disabled}
        className={`${baseClass} text-dim hover:bg-highlight-strong hover:text-secondary`}
        title={t('chat.voice.setUpTitle')}
        aria-label={t('chat.voice.setUpTitle')}
      >
        <Mic size={15} />
      </button>
    )
  }

  if (phase === 'transcribing') {
    return (
      <button
        type="button"
        disabled
        className={`${baseClass} text-dim`}
        title={t('chat.voice.transcribing')}
        aria-label={t('chat.voice.transcribing')}
      >
        <Loader2 size={15} className="animate-spin" />
      </button>
    )
  }

  const recording = phase === 'recording'
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      className={`${baseClass} ${
        recording
          ? 'text-error hover:text-error animate-pulse'
          : 'text-dim hover:bg-highlight-strong hover:text-secondary'
      }`}
      title={
        error
          ? t('chat.voice.errorTitle', {
              error: error === VOICE_NEEDS_GPU_ERROR ? t('chat.voice.needsGpu') : error,
            })
          : recording
            ? t('chat.voice.stopTitle')
            : t('chat.voice.startTitle')
      }
      aria-label={recording ? t('chat.voice.stopTitle') : t('chat.voice.startTitle')}
    >
      {recording ? <Square size={15} /> : <Mic size={15} />}
    </button>
  )
}
