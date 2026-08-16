import type { DiagnosticsProviderInfo, ModelsConfig, ProviderKeyState } from '../shared/ipc-contracts'

/**
 * Pure diagnostics-report helpers, Electron-free so they are unit-testable
 * (tray-decision.ts pattern). collectDiagnostics in diagnostics.ts does the
 * I/O and assembles these results.
 */

/** Classify a provider's apiKey field without ever evaluating secrets. */
export function classifyProviderKey(
  apiKey: unknown,
  env: NodeJS.ProcessEnv,
): { keyState: ProviderKeyState; envVar?: string } {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return { keyState: 'none' }
  if (apiKey.startsWith('$')) {
    const envVar = apiKey.slice(1)
    const value = env[envVar]
    return {
      keyState: value !== undefined && value !== '' ? 'env-set' : 'env-missing',
      envVar,
    }
  }
  if (apiKey.startsWith('!')) return { keyState: 'shell' }
  return { keyState: 'literal' }
}

/** Flatten a models config into per-provider diagnostics rows. */
export function summarizeProviders(
  config: ModelsConfig,
  env: NodeJS.ProcessEnv,
): DiagnosticsProviderInfo[] {
  return Object.entries(config.providers).map(([name, provider]) => {
    // The file-level validation only checks the providers RECORD; a hand-
    // edited entry value can be null or a non-object and must not take the
    // whole report down.
    const shape = typeof provider === 'object' && provider !== null ? provider : {}
    const { keyState, envVar } = classifyProviderKey(shape.apiKey, env)
    const info: DiagnosticsProviderInfo = {
      name,
      modelCount: Array.isArray(shape.models) ? shape.models.length : 0,
      keyState,
    }
    if (envVar !== undefined) info.envVar = envVar
    return info
  })
}

/** First line of `pi --version` output, or null when there is none. */
export function extractVersionLine(output: string): string | null {
  const line = output.trim().split('\n')[0]?.trim()
  return line ? line : null
}

/** Count entries on a platform-delimited PATH string. */
export function countPathEntries(pathEnv: string, isWindows: boolean): number {
  if (!pathEnv) return 0
  return pathEnv.split(isWindows ? ';' : ':').filter(Boolean).length
}

/**
 * Keep models.json failure text out of the shareable report when it may embed
 * file content: V8's JSON.parse errors quote the source around the bad token,
 * which can include literal apiKey material.
 */
export function sanitizeProvidersError(error: string): string {
  if (error.startsWith('models.json is not valid JSON')) return 'models.json is not valid JSON'
  return error
}
