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
}

let fallbackMessageCounter = 0

function generateFallbackId(): string {
  return `msg-${Date.now()}-${++fallbackMessageCounter}`
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
      timestamp: Number(m.timestamp) || Date.now(),
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
      timestamp: Number(m.timestamp) || Date.now(),
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
      timestamp: Number(m.timestamp) || Date.now(),
    }
  }

  return null
}
