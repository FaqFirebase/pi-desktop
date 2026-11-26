import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downmixToMono, encodeWav, resampleLinear, rms, TARGET_SAMPLE_RATE } from './voice-audio'

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

test('a WAV file holds 16-bit mono PCM at the given rate behind a 44-byte header', () => {
  const samples = Float32Array.from([0, 1, -1, 0.5, 2, -2])
  const wav = encodeWav(samples, TARGET_SAMPLE_RATE)
  const view = new DataView(wav.buffer)
  const ascii = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4))
  assert.equal(wav.byteLength, 44 + samples.length * 2)
  assert.equal(ascii(0), 'RIFF')
  assert.equal(view.getUint32(4, true), wav.byteLength - 8)
  assert.equal(ascii(8), 'WAVE')
  assert.equal(ascii(12), 'fmt ')
  assert.equal(view.getUint32(16, true), 16)
  assert.equal(view.getUint16(20, true), 1, 'PCM')
  assert.equal(view.getUint16(22, true), 1, 'mono')
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(28, true), 32000, 'bytes per second')
  assert.equal(view.getUint16(32, true), 2, 'block align')
  assert.equal(view.getUint16(34, true), 16, 'bits per sample')
  assert.equal(ascii(36), 'data')
  assert.equal(view.getUint32(40, true), samples.length * 2)
  // Full scale both ways; out-of-range samples are clipped, not wrapped.
  const pcm = Array.from({ length: samples.length }, (_, i) => view.getInt16(44 + i * 2, true))
  assert.deepEqual(pcm, [0, 32767, -32768, 16383, 32767, -32768])
})

test('an empty clip is a valid WAV file with no samples', () => {
  const wav = encodeWav(new Float32Array(0), TARGET_SAMPLE_RATE)
  assert.equal(wav.byteLength, 44)
  assert.equal(new DataView(wav.buffer).getUint32(40, true), 0)
})
