import { stripInjectedPreamble } from './session-preview'

/** A prior user message that can be forked from (RPC `get_fork_messages`). */
export interface ForkPoint {
  entryId: string
  text: string
}

/**
 * Normalize the RPC `get_fork_messages` payload into ForkPoints. The exact RPC
 * field names are tolerated (`entryId`|`id`, `text`|`content`) so a minor Pi
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

/** A chat message, as far as fork matching needs it. */
interface ChatMessageRef {
  id: string
  role: string
  content: string
}

/** The user's own words, without GUI-injected boilerplate such as the planning preamble. */
function userWords(text: string): string {
  return stripInjectedPreamble(text).trim()
}

/**
 * The fork point of the chat's user message `messageId`, or null when the
 * session does not hold it. Fork points list every user message with text;
 * compaction hides a session's early messages from the chat but not from the
 * fork points, so both lists are aligned at their ends, and the texts must
 * agree.
 */
export function forkPointForUserMessage(
  messages: readonly ChatMessageRef[],
  messageId: string,
  points: readonly ForkPoint[],
): ForkPoint | null {
  const userMessages = messages.filter((message) => message.role === 'user' && message.content)
  const index = userMessages.findIndex((message) => message.id === messageId)
  if (index === -1) return null
  const point = points[points.length - (userMessages.length - index)]
  return point && userWords(point.text) === userWords(userMessages[index].content) ? point : null
}
