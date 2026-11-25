import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic, Square, Loader2 } from 'lucide-react'
import type { VoiceDictation } from '../voice/use-voice-dictation'
import { VOICE_NEEDS_GPU_ERROR } from '../voice/voice-worker-protocol'
import { onVoiceShortcut, type VoiceShortcutCommand } from '../voice/voice-shortcut'
import { micState } from '../voice/mic-state'

// red while recording; red without the pulse after a failure, so it shows without a hover
const MIC_TONE = {
  recording: 'text-error hover:text-error animate-pulse',
  failed: 'text-error hover:bg-highlight-strong',
  idle: 'text-dim hover:bg-highlight-strong hover:text-secondary',
} as const

/**
 * Microphone button for the composer. Click to record; a running transcript
 * appears while you speak and it auto-stops after a short silence (click again
 * to stop sooner). The push-to-talk key records while held, and the
 * system-wide dictation key acts like a click. When no model is installed yet,
 * the button and both keys open Settings where the user picks one. It never
 * sends the message. The composer owns `dictation`, so sending can stop it.
 */
export function VoiceMicButton({
  dictation,
  disabled,
  openSettings,
  globalShortcuts,
}: {
  dictation: VoiceDictation
  disabled: boolean
  openSettings: () => Promise<void> | void
  globalShortcuts: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { phase, ready, error, toggle, hold, release } = dictation

  const runShortcut = (command: VoiceShortcutCommand) => {
    // A release always goes through, so a recording never outlives its key.
    if (command === 'release') return release()
    if (disabled) return
    if (!ready) return void openSettings()
    if (command === 'hold') hold()
    else toggle()
  }
  const runShortcutRef = useRef(runShortcut)
  runShortcutRef.current = runShortcut
  useEffect(() => {
    if (!globalShortcuts) return
    return onVoiceShortcut((command) => runShortcutRef.current(command))
  }, [globalShortcuts])

  const baseClass =
    'flex items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-50'

  const state = micState({ ready, phase, error })

  if (state === 'setUp') {
    return (
      <button
        type="button"
        onClick={() => { void openSettings() }}
        disabled={disabled}
        className={`${baseClass} text-dim hover:bg-highlight-strong hover:text-secondary`}
        title={t('chat.voice.setUpTitle')}
        aria-label={t('chat.voice.setUpTitle')}
      >
        <Mic size={15} />
      </button>
    )
  }

  if (state === 'transcribing') {
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

  const recording = state === 'recording'
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      className={`${baseClass} ${MIC_TONE[state]}`}
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
