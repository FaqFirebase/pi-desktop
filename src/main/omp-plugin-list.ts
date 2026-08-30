/**
 * Parsing for `omp plugin list --json`.
 *
 * OMP does not track packages in a settings.json `packages` array the way Pi
 * does — its plugin store lives in `~/.omp/plugins/` — so the GUI's installed
 * list comes from the CLI's JSON output: `{ "npm": [...], "marketplace": [...] }`.
 */

export interface InstalledPackage {
  name: string
  source: string
  type: string
  version: string | null
  path: string
}

/**
 * Entries are tolerated as bare name strings or objects carrying `name` plus
 * optional `version`/`source`/`spec` fields, so a CLI shape change degrades to
 * partial rows instead of an empty panel.
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
  for (const [group, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const item = ompPluginEntry(entry, group, pluginsDir)
      if (item) packages.push(item)
    }
  }
  return packages
}

function ompPluginEntry(entry: unknown, group: string, pluginsDir: string): InstalledPackage | null {
  if (typeof entry === 'string' && entry.length > 0) {
    return { name: entry, source: entry, type: group, version: null, path: pluginsDir }
  }
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as Record<string, unknown>
  const name = typeof e.name === 'string' && e.name.length > 0 ? e.name : null
  if (!name) return null
  const source = typeof e.source === 'string' ? e.source : typeof e.spec === 'string' ? e.spec : name
  return {
    name,
    source,
    type: group,
    version: typeof e.version === 'string' ? e.version : null,
    path: pluginsDir,
  }
}
