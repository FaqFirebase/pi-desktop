/**
 * Wrap untrusted text (file attachments, other agents' output) in an explicit,
 * labeled boundary before it is placed into a prompt. This marks the content as
 * data rather than instructions, so an attached file or consultant response
 * containing "ignore previous instructions..." is presented as quoted data at a
 * visible boundary instead of blending into the user's own message.
 */

const MARKER_PREFIX = '===== BEGIN UNTRUSTED '
const END_MARKER_PREFIX = '===== END UNTRUSTED '
const MARKER_SUFFIX = ' ====='

/** Label of a text file the user attached to a prompt, before the file name. */
const ATTACHED_FILE_LABEL = 'ATTACHED FILE: '

/** Separates the user's own words and each attached file in a sent prompt. */
const ATTACHED_FILE_SEPARATOR = '\n\n'

function beginMarker(label: string): string {
  return `${MARKER_PREFIX}${label}${MARKER_SUFFIX}`
}

function endMarker(label: string): string {
  return `${END_MARKER_PREFIX}${label}${MARKER_SUFFIX}`
}

/**
 * Render `content` inside a labeled untrusted-data block, optionally prefixed by
 * a guidance `note`. Any occurrence of this block's own closing marker inside
 * `content` is defused so the content cannot spoof the boundary and "break out".
 */
export function formatUntrustedBlock(label: string, content: string, note?: string): string {
  const end = endMarker(label)
  const defused = content.split(end).join(endMarker(`${label} (escaped)`))
  return [beginMarker(label), note, defused, end].filter((part) => part !== undefined && part !== '').join('\n')
}

/** A text file the user attached, as it is appended to the prompt after their own words. */
export function formatAttachedFile(name: string, content: string, note: string): string {
  return `${ATTACHED_FILE_SEPARATOR}${formatUntrustedBlock(`${ATTACHED_FILE_LABEL}${name}`, content, note)}`
}

/**
 * For display only: split a sent prompt back into the user's own words and the
 * names of the files `formatAttachedFile` appended, so the chat shows file
 * chips instead of the raw blocks. The prompt the model received is unchanged.
 */
export function splitAttachedFiles(prompt: string): { text: string; fileNames: string[] } {
  const fileNames: string[] = []
  const endPrefix = `\n${END_MARKER_PREFIX}${ATTACHED_FILE_LABEL}`
  let text = prompt
  // The blocks sit at the end, in attach order; take them off from the last.
  while (text.endsWith(MARKER_SUFFIX)) {
    const endAt = text.lastIndexOf(endPrefix)
    if (endAt === -1) break
    const name = text.slice(endAt + endPrefix.length, text.length - MARKER_SUFFIX.length)
    const beginAt = text.lastIndexOf(`${ATTACHED_FILE_SEPARATOR}${beginMarker(`${ATTACHED_FILE_LABEL}${name}`)}\n`, endAt)
    if (beginAt === -1) break
    fileNames.unshift(name)
    text = text.slice(0, beginAt)
  }
  return { text, fileNames }
}
