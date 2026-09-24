import type { VoicePrecision } from './voice-models'

// Where voice dictation runs its speech model. The user picks a device; the app
// pairs each place with the model precision that works there:
// - GPU runs fp16. onnxruntime-web's WebGPU backend lacks most int8 kernels, so
//   an int8 model on the GPU keeps handing work back to the CPU and is slower
//   than the CPU alone (measured: 1.9 s vs 1.3 s per sentence on an RX 9070).
//   fp16 on the GPU took 0.2 s per sentence.
// - CPU runs int8. An fp16 model is expanded to fp32 on the CPU and runs out
//   of WebAssembly memory (`std::bad_alloc` for Parakeet v3).

/** The user's choice. 'auto' picks the GPU when a hardware GPU is found. */
export type VoiceDevice = 'auto' | 'cpu' | 'gpu'

/** Where the model actually runs. */
export type VoiceRuntime = 'cpu' | 'gpu'

export const VOICE_DEVICES: readonly VoiceDevice[] = ['auto', 'cpu', 'gpu']

export function isVoiceDevice(value: unknown): value is VoiceDevice {
  return typeof value === 'string' && (VOICE_DEVICES as readonly string[]).includes(value)
}

/** Resolve the choice against the hardware: no usable GPU means the CPU. */
export function resolveVoiceRuntime(device: VoiceDevice, gpuAvailable: boolean): VoiceRuntime {
  return device !== 'cpu' && gpuAvailable ? 'gpu' : 'cpu'
}

/** The model precision to download and load for a runtime. */
export function precisionForRuntime(runtime: VoiceRuntime): VoicePrecision {
  return runtime === 'gpu' ? 'fp16' : 'int8'
}

/** The runtime an installed precision must run on. */
export function runtimeForPrecision(precision: VoicePrecision): VoiceRuntime {
  return precision === 'fp16' ? 'gpu' : 'cpu'
}

/**
 * Chromium keeps WebGPU off on Linux unless the app starts with
 * `--enable-unsafe-webgpu` and the Vulkan feature. Vulkan also changes how the
 * app draws, so the switches go on only when the user did not pick the CPU.
 */
export function needsLinuxGpuSwitches(platform: string, device: VoiceDevice): boolean {
  return platform === 'linux' && device !== 'cpu'
}
