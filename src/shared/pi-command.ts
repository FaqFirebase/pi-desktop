/** A command exposed by Pi via the RPC `get_commands` request. */
export interface PiCommand {
  name: string
  description: string
  source: 'skill' | 'prompt' | 'extension' | string
}

/**
 * Source used for Pi built-in commands that map to a GUI action rather than
 * being inserted as text. Pi's RPC only expands `/skill:` and `/template` from
 * typed input, so these built-ins run the equivalent GUI action directly.
 */
export const BUILTIN_SOURCE = 'builtin'

const GROUPS: Array<{ source: string; label: string }> = [
  { source: 'skill', label: 'Skills' },
  { source: 'prompt', label: 'Prompts' },
  { source: BUILTIN_SOURCE, label: 'Commands' },
  { source: 'extension', label: 'Extensions' },
]

export interface CommandGroup {
  label: string
  items: PiCommand[]
}

/**
 * Filter commands for the slash palette. A single leading "/" in the query is
 * ignored so typing "/rev" matches the same as "rev". Matching is
 * case-insensitive across name and description.
 */
export function filterCommands(commands: PiCommand[], query: string): PiCommand[] {
  const q = query.replace(/^\//, '').trim().toLowerCase()
  if (!q) return commands
  return commands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
  )
}

/**
 * True while the composer holds a bare slash-command token (`/` followed by a
 * command name, no whitespace yet). Once whitespace appears the user is typing
 * arguments after a chosen command, so command suggestions must not trigger.
 */
export function isSlashCommandToken(value: string): boolean {
  return value.startsWith('/') && !/\s/.test(value)
}

/** Token inserted into the composer when a skill/prompt/extension is chosen. */
export function invocationToken(name: string, source: string): string {
  if (source === 'skill') return `/skill:${name.replace(/^skill:/, '')} `
  return `/${name} `
}

/**
 * Group commands by source in display order (empty groups dropped), with an
 * "Other" catch-all for any unexpected source so nothing is silently hidden.
 * `flat` matches the visual order — keyboard navigation indexes it.
 */
export function groupCommands(results: PiCommand[]): {
  grouped: CommandGroup[]
  flat: PiCommand[]
} {
  const known = new Set(GROUPS.map((g) => g.source))
  const grouped = GROUPS.map((g) => ({
    label: g.label,
    items: results.filter((r) => r.source === g.source),
  })).filter((g) => g.items.length > 0)
  const other = results.filter((r) => !known.has(r.source))
  if (other.length > 0) grouped.push({ label: 'Other', items: other })
  return { grouped, flat: grouped.flatMap((g) => g.items) }
}
