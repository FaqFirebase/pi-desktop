// Finds the hardware GPU WebGPU would use for voice dictation. Works in the
// page and in a worker. The DOM lib has no WebGPU types; declare what we read.

interface GpuAdapterInfo {
  vendor?: string
  architecture?: string
  isFallbackAdapter?: boolean
}

interface GpuAdapter {
  info?: GpuAdapterInfo
  isFallbackAdapter?: boolean
}

interface GpuApi {
  requestAdapter(options: { powerPreference: string }): Promise<GpuAdapter | null>
}

/** Prefer the discrete GPU on machines that also have an integrated one. */
export const GPU_POWER_PREFERENCE = 'high-performance'

export interface GpuProbe {
  available: boolean
  /** Vendor and architecture, e.g. "amd rdna-4", when a GPU is available. */
  name: string | null
}

/**
 * A usable GPU is a real hardware adapter. `navigator.gpu` can exist while
 * requestAdapter() returns null, and a fallback adapter (SwiftShader) runs on
 * the CPU, slower than WebAssembly, so neither counts.
 */
export async function probeGpu(): Promise<GpuProbe> {
  try {
    const gpu = (navigator as unknown as { gpu?: GpuApi }).gpu
    const adapter = await gpu?.requestAdapter({ powerPreference: GPU_POWER_PREFERENCE })
    const isFallback = adapter?.info?.isFallbackAdapter ?? adapter?.isFallbackAdapter ?? false
    if (adapter && !isFallback) {
      const name = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ')
      return { available: true, name: name || null }
    }
  } catch {
    // No usable GPU.
  }
  return { available: false, name: null }
}
