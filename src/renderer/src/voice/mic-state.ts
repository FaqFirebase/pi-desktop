import type { VoicePhase } from './use-voice-dictation'

/** What the composer mic button shows. */
export type MicState = 'setUp' | 'transcribing' | 'recording' | 'failed' | 'idle'

// a failed dictation stays marked until the next one starts
export function micState({ ready, phase, error }: {
  ready: boolean
  phase: VoicePhase
  error: string | null
}): MicState {
  if (!ready) return 'setUp'
  if (phase !== 'idle') return phase
  return error ? 'failed' : 'idle'
}
