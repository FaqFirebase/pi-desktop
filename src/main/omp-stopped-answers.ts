import { readFile } from 'fs/promises'
import { isStoppedAnswer } from '../shared/stopped-answer'

/**
 * Stopped answers of a reloaded OMP session.
 *
 * OMP writes an answer the user stopped to the session file (stopReason
 * "aborted") and returns it from `get_messages` while the runtime that stopped
 * it is alive. A runtime that loads the session from disk leaves it out of
 * `get_messages`, so after a restart the chat lost the stopped text and its
 * "Stopped" mark. The GUI reads those answers from the session file and puts
 * them back in time order.
 */

interface SessionEntry {
  id?: unknown
  parentId?: unknown
  message?: Record<string, unknown>
}

function parseEntry(line: string): SessionEntry | null {
  try {
    const entry = JSON.parse(line) as unknown
    return entry && typeof entry === 'object' ? entry as SessionEntry : null
  } catch {
    return null
  }
}

/**
 * The stopped answers on the session's current branch, oldest first. The
 * branch is the parent chain of the last entry: a session file also keeps
 * abandoned branches, whose answers must not appear.
 */
export function stoppedAnswersOnBranch(content: string): Record<string, unknown>[] {
  const byId = new Map<string, SessionEntry>()
  let leaf: SessionEntry | null = null
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const entry = parseEntry(line)
    if (!entry || typeof entry.id !== 'string') continue
    byId.set(entry.id, entry)
    leaf = entry
  }
  const answers: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (let entry = leaf; entry && typeof entry.id === 'string' && !seen.has(entry.id);) {
    seen.add(entry.id)
    if (isStoppedAnswer(entry.message)) answers.push(entry.message)
    entry = typeof entry.parentId === 'string' ? byId.get(entry.parentId) ?? null : null
  }
  return answers.reverse()
}

function messageTime(message: Record<string, unknown>): number | null {
  const value = message.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.isFinite(Number(value)) ? Number(value) : Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/**
 * `messages` with every stopped answer it lacks inserted before the first
 * later message. An answer already present (same role and time) is not added
 * again, and one older than the first message stays out: that part of the
 * history was not sent.
 */
export function restoreStoppedAnswers(
  messages: readonly unknown[], stoppedAnswers: readonly Record<string, unknown>[],
): unknown[] {
  const result = [...messages]
  const times = (): Array<number | null> => result.map((message) =>
    message && typeof message === 'object' ? messageTime(message as Record<string, unknown>) : null)
  for (const answer of stoppedAnswers) {
    const time = messageTime(answer)
    if (time === null) continue
    const current = times()
    const present = result.some((message, index) =>
      current[index] === time && (message as { role?: unknown } | null)?.role === 'assistant')
    const first = current.find((value): value is number => value !== null)
    if (present || (first !== undefined && time < first)) continue
    const later = current.findIndex((value) => value !== null && value > time)
    result.splice(later === -1 ? result.length : later, 0, answer)
  }
  return result
}

/**
 * A `get_messages` response from a reloaded OMP session with its stopped
 * answers restored from `sessionPath`. Any read or shape problem returns the
 * response unchanged.
 */
export async function withStoppedAnswers(response: unknown, sessionPath: string): Promise<unknown> {
  const data = (response as { data?: { messages?: unknown } } | null)?.data
  if (!data || !Array.isArray(data.messages)) return response
  let content: string
  try {
    content = await readFile(sessionPath, 'utf8')
  } catch {
    return response
  }
  const answers = stoppedAnswersOnBranch(content)
  if (answers.length === 0) return response
  return { ...(response as object), data: { ...data, messages: restoreStoppedAnswers(data.messages, answers) } }
}
