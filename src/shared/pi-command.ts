/** A command exposed by Pi via the RPC `get_commands` request. */
export interface PiCommand {
  name: string
  description: string
  source: 'skill' | 'prompt' | 'extension' | string
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
