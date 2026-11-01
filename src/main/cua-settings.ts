import { readFileSync } from 'fs'
import { DEFAULT_SETTINGS } from '../shared/default-settings'
import { getSettingsPath } from './ipc/settings'

/** Where the Computer panel runs its Cua sessions: SSH host + local tunnel port. */
export interface CuaSettings {
  host: string
  tunnelPort: number
  /**
   * Local port mapped to the docker-host container's viewer (cua-spacesd on
   * 3211 inside). No settings-UI field yet; falls back to 3212 (3211 is taken
   * on this PC by the Cua Spaces host service).
   */
  dockerHostPort: number
}

/**
 * Read the CUA fields straight from settings.json, synchronously, with the
 * same fallbacks `normalizeStoredSettings` applies. Callers (SSH handlers,
 * webview security) run outside the settings IPC round-trip, so they read the
 * file the same way `readVoiceDeviceSync` does.
 */
export function readCuaSettingsSync(): CuaSettings {
  let stored: unknown = {}
  try {
    stored = JSON.parse(readFileSync(getSettingsPath(), 'utf-8'))
  } catch {
    stored = {}
  }
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const host = typeof raw.cuaHost === 'string' && raw.cuaHost.trim() && !/\s/.test(raw.cuaHost)
    ? raw.cuaHost.trim()
    : DEFAULT_SETTINGS.cuaHost
  const tunnelPort = Number.isInteger(raw.cuaTunnelPort) && (raw.cuaTunnelPort as number) >= 1024 && (raw.cuaTunnelPort as number) <= 65535
    ? (raw.cuaTunnelPort as number)
    : DEFAULT_SETTINGS.cuaTunnelPort
  const dockerHostPort = Number.isInteger(raw.cuaDockerHostPort) && (raw.cuaDockerHostPort as number) >= 1024 && (raw.cuaDockerHostPort as number) <= 65535
    ? (raw.cuaDockerHostPort as number)
    : 3212
  return { host, tunnelPort, dockerHostPort }
}
