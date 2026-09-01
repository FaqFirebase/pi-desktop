import type { InstalledPackage } from '../shared/ipc-contracts'

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
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    // The CLI may prefix warnings; retry on the outermost JSON object.
    const start = output.indexOf('{')
    const end = output.lastIndexOf('}')
    if (start === -1 || end <= start) return []
    try {
      parsed = JSON.parse(output.slice(start, end + 1))
    } catch {
      return []
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return []

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
