// Speech models take mono PCM at 16 kHz. These helpers turn a decoded
// AudioBuffer's channels into that shape. Pure math, so both the renderer and
// its tests can use them.

export const TARGET_SAMPLE_RATE = 16000

/** Hard cap on one recording, so a stuck mic can't run forever. */
export const MAX_RECORDING_MS = 60000

/** Name the microphone capture AudioWorklet registers its processor under. */
export const CAPTURE_PROCESSOR_NAME = 'pi-voice-capture'

/** Average every channel sample by sample into one mono track. */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]

  const frames = channels[0].length
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (const channel of channels) {
      sum += channel[i]
    }
    mono[i] = sum / channels.length
  }
  return mono
}

/** Root-mean-square level of a frame, used to detect speech versus silence. */
export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i]
  }
  return Math.sqrt(sum / frame.length)
}

/** Resample a mono signal to a new rate with linear interpolation. */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  targetRate: number,
): Float32Array {
  if (input.length === 0) return new Float32Array(0)
  if (inputRate === targetRate) return input

  const ratio = inputRate / targetRate
  const outLength = Math.round(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, input.length - 1)
    const fraction = position - left
    out[i] = input[left] * (1 - fraction) + input[right] * fraction
  }
  return out
}

const WAV_HEADER_BYTES = 44
// The RIFF size field counts the bytes after its own 8-byte chunk header.
const RIFF_CHUNK_HEADER_BYTES = 8
const MONO_CHANNELS = 1
const PCM16_BYTES = 2
const PCM16_MAX = 0x7fff
const PCM16_MIN = -0x8000
const WAV_FORMAT_PCM = 1
const WAV_FMT_CHUNK_BYTES = 16
const BITS_PER_BYTE = 8

/** Mono float samples in [-1, 1] as a 16-bit PCM WAV file, the format every transcription server accepts. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * PCM16_BYTES
  const view = new DataView(new ArrayBuffer(WAV_HEADER_BYTES + dataBytes))
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, WAV_HEADER_BYTES - RIFF_CHUNK_HEADER_BYTES + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, WAV_FMT_CHUNK_BYTES, true)
  view.setUint16(20, WAV_FORMAT_PCM, true)
  view.setUint16(22, MONO_CHANNELS, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * PCM16_BYTES, true)
  view.setUint16(32, PCM16_BYTES, true)
  view.setUint16(34, PCM16_BYTES * BITS_PER_BYTE, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(WAV_HEADER_BYTES + i * PCM16_BYTES, sample < 0 ? sample * -PCM16_MIN : sample * PCM16_MAX, true)
  }
  return new Uint8Array(view.buffer)
}
