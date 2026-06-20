/** A prior user message that can be forked from (RPC `get_fork_messages`). */
export interface ForkPoint {
  entryId: string
  text: string
}

/**
 * Normalize the RPC `get_fork_messages` payload into ForkPoints. The exact RPC
 * field names are tolerated (`entryId`|`id`, `text`|`content`) so a minor PI
 * schema difference does not break the UI. Entries without an id are dropped.
 */
export function normalizeForkMessages(raw: unknown): ForkPoint[] {
  if (!Array.isArray(raw)) return []
  const out: ForkPoint[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const id = rec.entryId ?? rec.id
    if (typeof id !== 'string' || id.length === 0) continue
    const text = rec.text ?? rec.content ?? ''
    out.push({ entryId: id, text: String(text) })
  }
  return out
}
