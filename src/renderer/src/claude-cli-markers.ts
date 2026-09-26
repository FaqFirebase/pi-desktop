import type { DisplayMessage } from './message-parsing'

// The pi-claude-cli provider runs Claude Code's own tools and records each one
// in the assistant text as a one-line marker (its "wire contract"):
//
//   [Claude Code · <Tool>]
//   [Claude Code · <Tool> <argsJson>]
//   [Claude Code · <Tool> #<toolUseId> <argsJson>]
//   [Claude Code · result #<toolUseId> <payloadJson>]
//
// Streamed text blocks arrive concatenated, so markers are found anywhere in
// the text, not only on their own line. Anything that does not scan as a
// complete marker stays prose.

type ToolCall = NonNullable<DisplayMessage['toolCalls']>[number]

const PREFIX = '[Claude Code · '

interface ScannedMarker {
  name: string
  id?: string
  payload?: Record<string, unknown>
  end: number
}

// End index (exclusive) of the JSON object starting at `start`, or -1 when the
// text ends before the object closes.
function jsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

// 'incomplete' when the text ends mid-marker (still streaming), null when the
// text at `start` is not a marker after all.
function scanMarker(text: string, start: number): ScannedMarker | 'incomplete' | null {
  let i = start + PREFIX.length
  const nameMatch = /^[^\s\]]+/.exec(text.slice(i))
  if (!nameMatch) return i >= text.length ? 'incomplete' : null
  const name = nameMatch[0]
  i += name.length

  let id: string | undefined
  const idMatch = /^ #([^\s\]]+)/.exec(text.slice(i))
  if (idMatch) {
    id = idMatch[1]
    i += idMatch[0].length
  }

  let payload: Record<string, unknown> | undefined
  if (text.startsWith(' {', i)) {
    const end = jsonObjectEnd(text, i + 1)
    if (end === -1) return 'incomplete'
    try {
      const parsed: unknown = JSON.parse(text.slice(i + 1, end))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      payload = parsed as Record<string, unknown>
    } catch {
      return null
    }
    i = end
  }

  if (i >= text.length) return 'incomplete'
  if (text[i] !== ']') return null
  return { name, id, payload, end: i + 1 }
}

function resultText(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined
  return typeof payload.summary === 'string' && payload.summary ? payload.summary : JSON.stringify(payload)
}

/**
 * Split pi-claude-cli tool markers out of assistant text. Call markers become
 * tool calls (paired with their result marker by id); the remaining text is
 * returned as prose. A marker cut off at the end of the text (mid-stream) is
 * dropped from the prose so it never flashes as raw text.
 */
export function splitClaudeCliMarkers(text: string): { content: string; toolCalls: ToolCall[] } {
  if (!text.includes(PREFIX)) return { content: text, toolCalls: [] }

  const toolCalls: ToolCall[] = []
  const byId = new Map<string, ToolCall>()
  let content = ''
  let cursor = 0
  let from = 0

  while (true) {
    const start = text.indexOf(PREFIX, from)
    if (start === -1) break
    const marker = scanMarker(text, start)
    if (marker === 'incomplete') {
      content += text.slice(cursor, start)
      return { content, toolCalls }
    }
    if (marker === null) {
      from = start + PREFIX.length
      continue
    }
    content += text.slice(cursor, start)
    cursor = from = marker.end

    if (marker.name === 'result') {
      const call = marker.id ? byId.get(marker.id) : undefined
      if (call) {
        call.result = resultText(marker.payload)
        call.isError = marker.payload?.status === 'error'
      }
      continue
    }
    const call: ToolCall = {
      id: marker.id ?? `claude-cli-${toolCalls.length}`,
      name: marker.name,
      arguments: JSON.stringify(marker.payload ?? {}),
    }
    toolCalls.push(call)
    if (marker.id) byId.set(marker.id, call)
  }

  content += text.slice(cursor)
  return { content, toolCalls }
}
