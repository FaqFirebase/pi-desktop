// Live dictation splits speech into segments at pauses. When the speaker
// pauses, the segment since the previous pause is transcribed once and its text
// is fixed. No audio is transcribed twice, which keeps CPU use low.

export interface DictationState {
  /** Speech heard at any point in this recording. */
  everSawSpeech: boolean
  /** Speech heard in the open segment (since the last fixed one). */
  segmentHasSpeech: boolean
  /** Time of the last level check that heard speech. */
  lastVoiceAt: number
}

/** True when the open segment holds speech followed by a pause of `pauseMs`. */
export function segmentPaused(state: DictationState, now: number, pauseMs: number): boolean {
  return state.segmentHasSpeech && now - state.lastVoiceAt >= pauseMs
}

/** True when every bit of speech is already in fixed text. */
export function allSpeechFixed(state: DictationState): boolean {
  return state.everSawSpeech && !state.segmentHasSpeech
}

/** Join transcript parts with one space, skipping empty parts. */
export function joinTranscript(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
}
