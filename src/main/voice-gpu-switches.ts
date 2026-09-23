import { readFileSync } from 'fs'
import { DEFAULT_SETTINGS } from '../shared/default-settings'
import { isVoiceDevice, needsLinuxGpuSwitches, type VoiceDevice } from '../shared/voice-device'

const ENABLE_UNSAFE_WEBGPU_SWITCH = 'enable-unsafe-webgpu'
const ENABLE_FEATURES_SWITCH = 'enable-features'
const VULKAN_FEATURE = 'Vulkan'

interface CommandLine {
  appendSwitch(name: string, value?: string): void
}

let switchesApplied = false

/**
 * The saved voice device, read synchronously: Chromium switches must be set
 * before the app is ready, before the async settings loader can run. A missing
 * or unreadable file means the default.
 */
export function readVoiceDeviceSync(settingsPath: string): VoiceDevice {
  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { voiceDevice?: unknown }
    if (isVoiceDevice(stored.voiceDevice)) return stored.voiceDevice
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_SETTINGS.voiceDevice
}

/**
 * Turn on WebGPU for voice dictation where Chromium keeps it off (Linux), unless
 * the user picked the CPU. Call once, before the app is ready.
 */
export function applyVoiceGpuSwitches(commandLine: CommandLine, platform: string, device: VoiceDevice): void {
  switchesApplied = needsLinuxGpuSwitches(platform, device)
  if (!switchesApplied) return
  commandLine.appendSwitch(ENABLE_UNSAFE_WEBGPU_SWITCH)
  commandLine.appendSwitch(ENABLE_FEATURES_SWITCH, VULKAN_FEATURE)
}

/** True when `device` needs other startup switches than this run started with. */
export function voiceGpuRestartRequired(platform: string, device: VoiceDevice): boolean {
  return needsLinuxGpuSwitches(platform, device) !== switchesApplied
}
