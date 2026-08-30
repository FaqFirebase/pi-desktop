import { join } from 'path'
import { existsSync } from 'fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ModelsConfig } from '../shared/ipc-contracts'

/**
 * Per-engine custom-models file resolution and (de)serialization.
 *
 * Pi keeps `~/.pi/agent/models.json` (JSON). OMP 18 moved to
 * `~/.omp/agent/models.yml` (YAML; `.yaml` also accepted) and only migrates a
 * legacy `models.json` once — writing JSON there would fight that migration,
 * so every OMP read and write targets the YAML file.
 */

export type ModelsFileFormat = 'json' | 'yaml'

export interface ModelsFileLocation {
  /** Agent config dir that holds the file (created on write when missing). */
  dir: string
  /** Absolute path of the models file. */
  file: string
  /** Basename, for user-facing messages ("models.yml is not valid…"). */
  name: string
  format: ModelsFileFormat
}

const OMP_MODELS_BASENAMES = ['models.yml', 'models.yaml'] as const
const PI_MODELS_BASENAME = 'models.json'

export function resolveModelsFile(engine: 'pi' | 'omp', homeDir: string): ModelsFileLocation {
  if (engine === 'omp') {
    const dir = join(homeDir, '.omp', 'agent')
    const existing = OMP_MODELS_BASENAMES.find((name) => existsSync(join(dir, name)))
    const name = existing ?? OMP_MODELS_BASENAMES[0]
    return { dir, file: join(dir, name), name, format: 'yaml' }
  }
  const dir = join(homeDir, '.pi', 'agent')
  return { dir, file: join(dir, PI_MODELS_BASENAME), name: PI_MODELS_BASENAME, format: 'json' }
}

/**
 * Parse a models file's raw text. YAML is a superset of JSON, so the YAML
 * parser also accepts a legacy JSON payload sitting in a `.yml` file.
 * Throws on malformed input — callers own the error presentation.
 */
export function parseModelsFile(raw: string, format: ModelsFileFormat): unknown {
  return format === 'json' ? JSON.parse(raw) : parseYaml(raw)
}

export function serializeModelsFile(config: ModelsConfig, format: ModelsFileFormat): string {
  if (format === 'json') return JSON.stringify(config, null, 2) + '\n'
  return stringifyYaml(config)
}

/** Shared shape check: a models config is an object with a `providers` map. */
export function isModelsConfig(value: unknown): value is ModelsConfig {
  if (typeof value !== 'object' || value === null) return false
  const providers = (value as { providers?: unknown }).providers
  return typeof providers === 'object' && providers !== null && !Array.isArray(providers)
}
