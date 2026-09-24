import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allSpeechFixed,
  joinTranscript,
  segmentPaused,
  type DictationState,
} from './voice-speech-coverage'

const PAUSE_MS = 600
const NOW = 20_000

function state(overrides: Partial<DictationState>): DictationState {
  return { everSawSpeech: true, segmentHasSpeech: true, lastVoiceAt: NOW, ...overrides }
}

test('speech followed by a full pause closes the segment', () => {
  assert.equal(segmentPaused(state({ lastVoiceAt: NOW - PAUSE_MS }), NOW, PAUSE_MS), true)
})

test('a gap shorter than the pause does not close the segment', () => {
  assert.equal(segmentPaused(state({ lastVoiceAt: NOW - PAUSE_MS + 1 }), NOW, PAUSE_MS), false)
})

test('silence with no speech in the segment closes nothing', () => {
  assert.equal(segmentPaused(state({ segmentHasSpeech: false, lastVoiceAt: 0 }), NOW, PAUSE_MS), false)
})

test('all speech is fixed only when speech was heard and the open segment has none', () => {
  assert.equal(allSpeechFixed(state({ segmentHasSpeech: false })), true)
  assert.equal(allSpeechFixed(state({ segmentHasSpeech: true })), false)
})

test('a quiet mic that never crossed the speech level has nothing fixed', () => {
  // The final pass must then transcribe the whole recording.
  assert.equal(allSpeechFixed(state({ everSawSpeech: false, segmentHasSpeech: false })), false)
})

test('joinTranscript joins non-empty parts with one space', () => {
  assert.equal(joinTranscript('First part.', 'Second part.'), 'First part. Second part.')
  assert.equal(joinTranscript('', 'Only this.'), 'Only this.')
  assert.equal(joinTranscript('Only this.', '  '), 'Only this.')
})
