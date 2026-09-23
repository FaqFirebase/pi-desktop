// Speech models take mono PCM at 16 kHz. These helpers turn a decoded
// AudioBuffer's channels into that shape. Pure math, so both the renderer and
// its tests can use them.

export const TARGET_SAMPLE_RATE = 16000

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
