import {
  CAPTURE_PROCESSOR_NAME,
  resampleLinear,
  rms,
  TARGET_SAMPLE_RATE,
} from '../../../shared/voice-audio'
import captureWorkletUrl from './capture-worklet?worker&url'

// Loudness is measured over this many of the newest capture blocks (128 frames
// each, so about 85 ms at 48 kHz), not over one tiny block.
const LEVEL_WINDOW_BLOCKS = 32

/**
 * Captures microphone audio continuously as raw PCM. Capture runs in an
 * AudioWorklet on the audio thread, so no audio is lost while the page is busy.
 * The buffer can be read at any time during recording (getPcm16k) so a running
 * transcript can be produced while the user is still speaking, and getLevel()
 * drives silence-based auto-stop.
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private capture: AudioWorkletNode | null = null
  private chunks: Float32Array[] = []
  private frames = 0
  private sampleRate = TARGET_SAMPLE_RATE

  async start(): Promise<void> {
    try {
      await this.open()
    } catch (err) {
      // Turn the mic off again if any later setup step fails.
      this.release()
      throw err
    }
  }

  private async open(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.context = new AudioContext()
    this.sampleRate = this.context.sampleRate
    await this.context.audioWorklet.addModule(captureWorkletUrl)
    this.source = this.context.createMediaStreamSource(this.stream)
    this.capture = new AudioWorkletNode(this.context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
    })
    this.chunks = []
    this.frames = 0

    this.capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.chunks.push(event.data)
      this.frames += event.data.length
    }

    this.source.connect(this.capture)
  }

  /** Current input loudness (0 = silence), for silence detection. */
  getLevel(): number {
    return rms(mergeChunks(this.chunks.slice(-LEVEL_WINDOW_BLOCKS)))
  }

  /** Number of captured frames so far, a position for getPcm16k. */
  frameCount(): number {
    return this.frames
  }

  /**
   * Captured audio from frame `from` up to frame `to` (default: all so far), as
   * mono 16 kHz PCM. Safe to call repeatedly.
   */
  getPcm16k(from = 0, to = this.frames): Float32Array {
    const range = mergeChunks(this.chunks).subarray(from, to)
    return resampleLinear(range, this.sampleRate, TARGET_SAMPLE_RATE)
  }

  /** Stop recording and return the audio from frame `from` on as mono 16 kHz PCM. */
  async stop(from = 0): Promise<Float32Array> {
    const pcm = this.getPcm16k(from)
    this.release()
    return pcm
  }

  /** Abort recording and drop the audio. */
  cancel(): void {
    this.release()
  }

  private release(): void {
    this.source?.disconnect()
    if (this.capture) this.capture.port.onmessage = null
    this.capture?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.capture = null
    this.source = null
    this.stream = null
    this.context = null
  }
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}
