export interface DisplayAttachment {
  kind: 'image'
  name: string
  mimeType: string
  data: string
}

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'toolResult' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  toolCalls?: Array<{
    id: string
    name: string
    arguments: string
    result?: string
    isError?: boolean
    isExecuting?: boolean
    durationMs?: number
  }>
  thinking?: string
  model?: string
  provider?: string
  cost?: number
  attachments?: DisplayAttachment[]
  // toolResult only: the id/name of the tool call this result answers. `toolName`
  // and `toolFile` (the operated-on file) are resolved from the paired call by
  // prepareChatMessages so the result can render richly (highlight / diff).
  toolCallId?: string
  toolName?: string
  toolFile?: string
}

let fallbackMessageCounter = 0

function generateFallbackId(): string {
  return `msg-${Date.now()}-${++fallbackMessageCounter}`
}

// Pi's session records store timestamps as ISO strings, but the RPC layer may
// hand them back as epoch ms (or an ms string). Accept all three so relative-time
// labels are correct for loaded history — a bare `Number(iso)` would be NaN and
// silently fall back to "now", making every resumed message read as just-sent.
function parseTimestamp(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Guard against epoch-seconds being read as 1970.
    return raw < 1e12 ? raw * 1000 : raw
  }
  if (typeof raw === 'string' && raw.trim()) {
    const asNumber = Number(raw)
    if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber
    const asDate = Date.parse(raw)
    if (!Number.isNaN(asDate)) return asDate
  }
  return Date.now()
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block: unknown) => {
        if (typeof block !== 'object' || block === null) return false
        const b = block as Record<string, unknown>
        return b.type === 'text' && typeof b.text === 'string'
      })
      .map((block) => (block as { text: string }).text)
      .join('')
  }
  return ''
}

function extractImageAttachments(content: unknown): DisplayAttachment[] | undefined {
  if (!Array.isArray(content)) return undefined

  let imageIndex = 0
  const images = content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null) return []
    const b = block as Record<string, unknown>
    if (b.type !== 'image' || typeof b.mimeType !== 'string' || typeof b.data !== 'string') return []
    imageIndex += 1
    return [{
      kind: 'image' as const,
      name: typeof b.name === 'string' && b.name.trim() ? b.name : `Image ${imageIndex}`,
      mimeType: b.mimeType,
      data: b.data,
    }]
  })

  return images.length > 0 ? images : undefined
}

export function parseAgentMessage(msg: unknown): DisplayMessage | null {
  if (!msg || typeof msg !== 'object') return null

  const m = msg as Record<string, unknown>
  const role = m.role as string

  if (role === 'user') {
    return {
      id: String(m.id ?? generateFallbackId()),
      role: 'user',
      content: extractTextContent(m.content),
      timestamp: parseTimestamp(m.timestamp),
      attachments: extractImageAttachments(m.content),
    }
  }

  if (role === 'assistant') {
    const content = Array.isArray(m.content) ? m.content : []
    const textParts = content
      .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text')
      .map((c: unknown) => ((c as Record<string, unknown>).text as string) ?? '')

    const thinkingParts = content
      .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'thinking')
      .map((c: unknown) => ((c as Record<string, unknown>).thinking as string) ?? '')

    const toolCalls = content
      .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'toolCall')
      .map((c: unknown) => {
        const tc = c as Record<string, unknown>
        return {
          id: String(tc.id ?? ''),
          name: String(tc.name ?? ''),
          arguments: JSON.stringify(tc.arguments ?? {}),
        }
      })

    return {
      id: String(m.id ?? generateFallbackId()),
      role: 'assistant',
      content: textParts.join(''),
      timestamp: parseTimestamp(m.timestamp),
      thinking: thinkingParts.length > 0 ? thinkingParts.join('') : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: typeof m.model === 'string' ? m.model : undefined,
      provider: typeof m.provider === 'string' ? m.provider : undefined,
    }
  }

  if (role === 'toolResult') {
    const content = Array.isArray(m.content) ? m.content : []
    const text = content
      .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text')
      .map((c: unknown) => ((c as Record<string, unknown>).text as string) ?? '')
      .join('')

    return {
      id: String(m.id ?? generateFallbackId()),
      role: 'toolResult',
      content: text,
      timestamp: parseTimestamp(m.timestamp),
      toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
      toolName: typeof m.toolName === 'string' ? m.toolName : undefined,
    }
  }

  return null
}
