/**
 * Wrap untrusted text (file attachments, other agents' output) in an explicit,
 * labeled boundary before it is placed into a prompt. This marks the content as
 * data rather than instructions, so an attached file or consultant response
 * containing "ignore previous instructions..." is presented as quoted data at a
 * visible boundary instead of blending into the user's own message.
 */

const MARKER_PREFIX = '===== BEGIN UNTRUSTED '
const MARKER_SUFFIX = ' ====='

/**
 * Render `content` inside a labeled untrusted-data block, optionally prefixed by
 * a guidance `note`. Any occurrence of this block's own closing marker inside
 * `content` is defused so the content cannot spoof the boundary and "break out".
 */
export function formatUntrustedBlock(label: string, content: string, note?: string): string {
  const begin = `${MARKER_PREFIX}${label}${MARKER_SUFFIX}`
  const end = `===== END UNTRUSTED ${label}${MARKER_SUFFIX}`
  const defused = content.split(end).join(`===== END UNTRUSTED ${label} (escaped)${MARKER_SUFFIX}`)
  return [begin, note, defused, end].filter((part) => part !== undefined && part !== '').join('\n')
}
