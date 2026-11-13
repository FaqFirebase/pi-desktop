import type { InstalledPackage } from '../shared/ipc-contracts'
import { parseCliJsonObject } from './cli-json'

/**
 * Parsing for `omp plugin list --json`.
 *
 * OMP does not track packages in a settings.json `packages` array the way Pi
 * does — its plugin store lives in `~/.omp/plugins/` — so the GUI's installed
 * list comes from the CLI's JSON output: `{ "npm": [...], "marketplace": [...] }`.
 *
 * Row shapes as OMP 18 emits them:
 *  - npm:         `{ name, version, path, manifest, enabledFeatures, enabled }`
 *  - marketplace: `{ id: "<plugin>@<marketplace>", scope, entries, shadowedBy? }`
 * Marketplace rows carry no `name`; their `id` is also the spec
 * `omp plugin uninstall` expects, so it doubles as the row's source.
 */
export function parseOmpPluginList(output: string, pluginsDir: string): InstalledPackage[] {
  const parsed = parseCliJsonObject(output)
  if (!parsed) return []

  const packages: InstalledPackage[] = []
  for (const entries of Object.values(parsed)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const item = ompPluginEntry(entry, pluginsDir)
      if (item) packages.push(item)
    }
  }
  return packages
}

/**
 * An npm-installed OMP plugin with the runtime state a reinstall resets:
 * `omp install` re-enables the plugin and replaces its feature selection, so
 * an update must carry both across. `enabledFeatures` is null when the plugin
 * runs its default features.
 */
export interface OmpNpmPlugin {
  name: string
  version: string | null
  enabled: boolean
  enabledFeatures: string[] | null
}

/** The `npm` rows of `omp plugin list --json`; marketplace rows are skipped. */
export function parseOmpNpmPlugins(output: string): OmpNpmPlugin[] {
  const parsed = parseCliJsonObject(output)
  const rows = parsed?.npm
  if (!Array.isArray(rows)) return []

  const plugins: OmpNpmPlugin[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const e = row as Record<string, unknown>
    const name = nonEmptyString(e.name)
    if (!name) continue
    plugins.push({
      name,
      version: nonEmptyString(e.version),
      enabled: e.enabled !== false,
      enabledFeatures: Array.isArray(e.enabledFeatures)
        ? e.enabledFeatures.filter((feature): feature is string => typeof feature === 'string')
        : null,
    })
  }
  return plugins
}

function ompPluginEntry(entry: unknown, pluginsDir: string): InstalledPackage | null {
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as Record<string, unknown>
  const name = nonEmptyString(e.name) ?? nonEmptyString(e.id)
  if (!name) return null
  return {
    name,
    source: name,
    type: 'package',
    version: nonEmptyString(e.version) ?? null,
    path: nonEmptyString(e.path) ?? pluginsDir,
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
