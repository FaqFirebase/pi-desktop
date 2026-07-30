/**
 * Turns a session's first user message into a one-line row label.
 *
 * Pure string helpers, shared because main reads the message off disk while the
 * renderer owns the planning-mode preamble those messages can carry — the
 * sentinels below must have exactly one definition or the two would drift.
 */

/**
 * Longest preview kept on the IPC wire and in a row title. Every render site
 * CSS-truncates to its own width, so this only has to bound the payload and
 * leave enough text to tell two sessions apart.
 */
export const MAX_PREVIEW_CHARS = 120

/** Marks a preview that was cut short. */
const ELLIPSIS = '…'

/**
 * Planning mode prepends a fixed preamble to the user's prompt, so the stored
 * first message of every planning session opens with the same boilerplate and
 * would preview identically. `buildPlanningPrompt` composes both sentinels, so
 * the real request can be recovered by locating the second one.
 */
export const PLANNING_PREAMBLE_OPENING = 'You are in read-only planning mode.'
export const PLANNING_PREAMBLE_SENTINEL = 'User request:'

/**
 * Recover the user's own words from a message that opens with GUI-injected
 * boilerplate. The text must *start* with the preamble, so a message that merely
 * quotes the sentinel keeps everything before it.
 */
export function stripInjectedPreamble(text: string): string {
  if (!text.startsWith(PLANNING_PREAMBLE_OPENING)) return text

  const sentinelAt = text.indexOf(PLANNING_PREAMBLE_SENTINEL)
  if (sentinelAt === -1) return text

  const request = text.slice(sentinelAt + PLANNING_PREAMBLE_SENTINEL.length).trim()
  // A preamble with nothing after it is still better than an empty preview.
  return request || text
}

/**
 * Collapse a message to a single capped line, or null when it carries no visible
 * characters. Truncation counts code points, so a cut never lands inside a
 * surrogate pair and leaves a replacement character behind.
 */
export function sessionPreview(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null

  const points = Array.from(collapsed)
  if (points.length <= MAX_PREVIEW_CHARS) return collapsed
  return points.slice(0, MAX_PREVIEW_CHARS).join('') + ELLIPSIS
}
