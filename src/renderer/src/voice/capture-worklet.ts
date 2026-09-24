// Runs on the audio rendering thread. It copies each block of microphone
// samples to the page through the node's port. Posted messages queue until the
// page reads them, so no audio is lost while the page is busy (for example
// while a speech model runs). A ScriptProcessorNode drops blocks in that case.

import { CAPTURE_PROCESSOR_NAME } from '../../../shared/voice-audio'

// The DOM lib has no AudioWorkletGlobalScope types; declare the two we use.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][]): boolean
  },
): void

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (channel) this.port.postMessage(channel.slice())
    return true
  }
}

registerProcessor(CAPTURE_PROCESSOR_NAME, CaptureProcessor)
