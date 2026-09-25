import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceModel } from '../../../shared/voice-models'
import type { VoiceStatus } from '../../../shared/ipc-contracts'
import { useAppStore } from '../store'
import { VoiceRecorder } from './voice-recorder'
import { transcribeAudio } from './voice-transcriber'
import {
  allSpeechFixed,
  joinTranscript,
  segmentPaused,
  type DictationState,
} from '../../../shared/voice-speech-coverage'

export type VoicePhase = 'idle' | 'recording' | 'transcribing'

// Live-dictation tuning.
const TICK_MS = 250 // how often we check the input level
const PAUSE_MS = 600 // quiet this long after speech transcribes and fixes that part
const SILENCE_LEVEL = 0.008 // RMS below this counts as silence
const SILENCE_HOLD_MS = 8000 // stop after this much silence following speech
const MAX_RECORDING_MS = 60000 // hard cap so a stuck mic can't run forever

/** One recording: fixed text of transcribed segments plus the open segment. */
interface DictationSession {
  state: DictationState
  /** Text of all transcribed segments. */
  fixedText: string
  /** Recorder frame where the open segment starts. */
  fixedFrame: number
  /** The segment pass now running, if any. */
  pass: Promise<void> | null
  /** A segment pass failed; the final pass alone retries, once. */
  passFailed: boolean
}

function newSession(startedAt: number): DictationSession {
  return {
    state: { everSawSpeech: false, segmentHasSpeech: false, lastVoiceAt: startedAt },
    fixedText: '',
    fixedFrame: 0,
    pass: null,
    passFailed: false,
  }
}

export interface VoiceDictationHandlers {
  /** Recording started: mark the composer insertion point. */
  onStart: () => void
  /** Transcript so far, replacing the previous interim text. */
  onInterim: (text: string) => void
  /** Final transcript once recording stops. */
  onFinal: (text: string) => void
}

export interface VoiceDictation {
  phase: VoicePhase
  ready: boolean
  model: VoiceModel | undefined
  error: string | null
  toggle: () => void
}

/**
 * Drives the microphone button. Each time the speaker pauses, the speech since
 * the previous pause is transcribed once and added to the composer, so no audio
 * is transcribed twice. It auto-stops after a longer silence, transcribes any
 * speech left after the last pause, and never sends.
 */
export function useVoiceDictation(handlers: VoiceDictationHandlers): VoiceDictation {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const currentView = useAppStore((s) => s.currentView)

  const recorderRef = useRef<VoiceRecorder | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stoppedRef = useRef(false)
  // True while the mic is opening, before phase turns 'recording'; a second
  // click then must not open a second mic that nothing would close.
  const startingRef = useRef(false)
  const sessionRef = useRef<DictationSession>(newSession(0))
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const model = status?.catalog.find((entry) => entry.id === status.selectedModel)
  const installed = Boolean(
    status?.selectedModel && status.installed.some((m) => m.id === status.selectedModel),
  )
  const ready = Boolean(model && installed)

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      stoppedRef.current = true
      clearTimer()
      recorderRef.current?.cancel()
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.piDesktop.voice.status().then((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
    }
  }, [currentView])

  const finalize = useCallback(async () => {
    if (stoppedRef.current) return
    stoppedRef.current = true
    clearTimer()
    const recorder = recorderRef.current
    recorderRef.current = null
    if (!recorder || !model || !status) {
      setPhase('idle')
      return
    }
    const session = sessionRef.current
    setPhase('transcribing')
    try {
      // A segment pass still running fixes its text first, so its audio is not
      // transcribed again below.
      await session.pass
      if (allSpeechFixed(session.state)) {
        recorder.cancel()
        handlersRef.current.onFinal(session.fixedText)
        return
      }
      const pcm = await recorder.stop(session.fixedFrame)
      const tail = pcm.length > 0 ? await transcribeAudio(pcm, model, status.selectedPrecision) : ''
      handlersRef.current.onFinal(joinTranscript(session.fixedText, tail))
    } catch (err) {
      console.error('[voice] transcription failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPhase('idle')
    }
  }, [model, status])

  const startRecording = useCallback(async () => {
    if (!model || !status || !ready || startingRef.current) return
    startingRef.current = true
    setError(null)
    stoppedRef.current = false
    try {
      const recorder = new VoiceRecorder()
      await recorder.start()
      recorderRef.current = recorder
      handlersRef.current.onStart()
      setPhase('recording')

      const startedAt = Date.now()
      const session = newSession(startedAt)
      sessionRef.current = session
      const { state } = session

      timerRef.current = setInterval(() => {
        if (stoppedRef.current) return
        const now = Date.now()
        if (recorder.getLevel() >= SILENCE_LEVEL) {
          state.lastVoiceAt = now
          state.everSawSpeech = true
          state.segmentHasSpeech = true
        }

        if (!session.pass && !session.passFailed && segmentPaused(state, now, PAUSE_MS)) {
          const toFrame = recorder.frameCount()
          const pcm = recorder.getPcm16k(session.fixedFrame, toFrame)
          session.pass = transcribeAudio(pcm, model, status.selectedPrecision)
            .then((text) => {
              session.fixedText = joinTranscript(session.fixedText, text)
              session.fixedFrame = toFrame
              // Speech that began after this pass took its audio opens the next segment.
              state.segmentHasSpeech = state.lastVoiceAt > now
              if (!stoppedRef.current) handlersRef.current.onInterim(session.fixedText)
            })
            .catch((err) => {
              // A failed load or run would fail the same way at every pause
              // (and reload the model each time), so stop here: the segment
              // stays open for the final pass, and the error shows now.
              session.passFailed = true
              setError(err instanceof Error ? err.message : String(err))
            })
            .finally(() => {
              session.pass = null
            })
        }

        const silentTooLong = state.everSawSpeech && now - state.lastVoiceAt >= SILENCE_HOLD_MS
        if (silentTooLong || now - startedAt >= MAX_RECORDING_MS) {
          void finalize()
        }
      }, TICK_MS)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('idle')
    } finally {
      startingRef.current = false
    }
  }, [model, status, ready, finalize])

  const toggle = useCallback(() => {
    if (phase === 'recording') {
      void finalize()
    } else if (phase === 'idle') {
      void startRecording()
    }
  }, [phase, finalize, startRecording])

  return { phase, ready, model, error, toggle }
}
