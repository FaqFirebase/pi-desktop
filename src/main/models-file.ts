import { join } from 'path'
import { existsSync } from 'fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { AgentEngineKind, ModelsConfig } from '../shared/ipc-contracts'

/**
 * Per-engine custom-models file resolution and (de)serialization.
 *
 * Pi keeps `~/.pi/agent/models.json` (JSON). OMP 18 moved to
 * `~/.omp/agent/models.yml` (YAML; `.yaml` also accepted). OMP migrates a
 * legacy `models.json` on startup, but only while no YAML file exists yet, so
 * until OMP has run once after an upgrade the GUI keeps reading and writing
 * that legacy JSON file — creating `models.yml` beside it would block the
 * migration and strand the providers in the old file.
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

export const OMP_MODELS_BASENAMES = ['models.yml', 'models.yaml'] as const
export const PI_MODELS_BASENAME = 'models.json'

export function resolveModelsFile(engine: AgentEngineKind, homeDir: string): ModelsFileLocation {
  if (engine === 'omp') {
    const dir = join(homeDir, '.omp', 'agent')
    const yaml = OMP_MODELS_BASENAMES.find((name) => existsSync(join(dir, name)))
    if (yaml) return { dir, file: join(dir, yaml), name: yaml, format: 'yaml' }
    if (existsSync(join(dir, PI_MODELS_BASENAME))) {
      return { dir, file: join(dir, PI_MODELS_BASENAME), name: PI_MODELS_BASENAME, format: 'json' }
    }
    const name = OMP_MODELS_BASENAMES[0]
    return { dir, file: join(dir, name), name, format: 'yaml' }
  }
  const dir = join(homeDir, '.pi', 'agent')
  return { dir, file: join(dir, PI_MODELS_BASENAME), name: PI_MODELS_BASENAME, format: 'json' }
}

/**
 * Parse a models file's raw text. YAML is a superset of JSON, so the YAML
 * parser also accepts a legacy JSON payload sitting in a `.yml` file. An
 * empty or comment-only YAML document (and a bare `providers:` key) is an
 * empty config, not an error — a user may `touch` the file before editing.
 * Throws on malformed input — callers own the error presentation.
 */
export function parseModelsFile(raw: string, format: ModelsFileFormat): unknown {
  if (format === 'json') return JSON.parse(raw)
  const parsed: unknown = parseYaml(raw)
  if (parsed === null || parsed === undefined) return { providers: {} }
  if (typeof parsed === 'object' && 'providers' in parsed && (parsed as { providers: unknown }).providers === null) {
    return { ...parsed, providers: {} }
  }
  return parsed
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
