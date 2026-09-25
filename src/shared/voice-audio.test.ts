import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downmixToMono, resampleLinear, rms, TARGET_SAMPLE_RATE } from './voice-audio'

test('the target sample rate is 16 kHz, what the models expect', () => {
  assert.equal(TARGET_SAMPLE_RATE, 16000)
})

test('downmix of a single channel returns the same samples', () => {
  const mono = downmixToMono([Float32Array.from([0.5, 0.25, -0.75])])
  assert.deepEqual(Array.from(mono), [0.5, 0.25, -0.75])
})

test('downmix averages stereo channels sample by sample', () => {
  const left = Float32Array.from([0, 1, -1])
  const right = Float32Array.from([1, 1, 1])
  const mono = downmixToMono([left, right])
  assert.deepEqual(Array.from(mono), [0.5, 1, 0])
})

test('downmix of no channels returns an empty array', () => {
  assert.equal(downmixToMono([]).length, 0)
})

test('resampling to the same rate leaves the audio unchanged', () => {
  const input = Float32Array.from([0, 0.5, 1])
  const out = resampleLinear(input, 16000, 16000)
  assert.deepEqual(Array.from(out), [0, 0.5, 1])
})

test('downsampling halves the sample count for a 2:1 ratio', () => {
  const input = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7])
  const out = resampleLinear(input, 32000, 16000)
  assert.equal(out.length, 4)
  assert.equal(out[0], 0)
  assert.equal(out[1], 2)
})

test('resampling an empty signal yields an empty signal', () => {
  assert.equal(resampleLinear(new Float32Array(0), 44100, 16000).length, 0)
})

test('rms of silence is zero', () => {
  assert.equal(rms(new Float32Array([0, 0, 0, 0])), 0)
})

test('rms of a full-scale square signal is one', () => {
  assert.equal(rms(Float32Array.from([1, -1, 1, -1])), 1)
})

test('rms of an empty frame is zero, not NaN', () => {
  assert.equal(rms(new Float32Array(0)), 0)
})
