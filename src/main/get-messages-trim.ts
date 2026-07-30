/** How many messages to ship to the renderer (most recent). */
export const MAX_MESSAGES_FOR_UI = 150
/** Cap individual text/tool blobs so one bash dump can't freeze paint. */
export const MAX_CONTENT_CHARS = 80_000
/** Cap base64 image payloads reloaded from history (drop rather than ship). */
export const MAX_IMAGE_DATA_CHARS = 200_000

/**
 * Shrink a Pi `get_messages` response before IPC. Drops old turns and truncates
 * huge tool outputs / assistant bodies. Shape is preserved for the renderer parser.
 */
export function trimGetMessagesResponse(response: unknown): unknown {
  if (!response || typeof response !== 'object') return response
  const root = response as Record<string, unknown>
  const data = root.data
  if (!data || typeof data !== 'object') return response
  const dataObj = data as Record<string, unknown>
  const messages = dataObj.messages
  if (!Array.isArray(messages)) return response

  const sliced =
    messages.length > MAX_MESSAGES_FOR_UI
      ? messages.slice(messages.length - MAX_MESSAGES_FOR_UI)
      : messages

  const trimmed = sliced.map((msg) => trimMessagePayload(msg))
  return {
    ...root,
    data: {
      ...dataObj,
      messages: trimmed,
      // Hint for UI if we dropped older turns (optional; renderer may ignore).
      truncatedFromStart: messages.length > MAX_MESSAGES_FOR_UI,
      totalMessageCount: messages.length,
    },
  }
}

export function trimMessagePayload(msg: unknown): unknown {
  if (!msg || typeof msg !== 'object') return msg
  const m = msg as Record<string, unknown>
  const next: Record<string, unknown> = { ...m }

  if (typeof next.content === 'string' && next.content.length > MAX_CONTENT_CHARS) {
    next.content =
      next.content.slice(0, MAX_CONTENT_CHARS) +
      `\n\n… truncated ${next.content.length - MAX_CONTENT_CHARS} characters for UI performance`
  } else if (Array.isArray(next.content)) {
    next.content = next.content.map((block) => {
      if (!block || typeof block !== 'object') return block
      const b = block as Record<string, unknown>
      if (typeof b.text === 'string' && b.text.length > MAX_CONTENT_CHARS) {
        return {
          ...b,
          text:
            b.text.slice(0, MAX_CONTENT_CHARS) +
            `\n\n… truncated ${b.text.length - MAX_CONTENT_CHARS} characters for UI performance`,
        }
      }
      // Drop huge base64 image reloads in history if somehow embedded as data.
      if (b.type === 'image' && typeof b.data === 'string' && b.data.length > MAX_IMAGE_DATA_CHARS) {
        return { ...b, data: '', mimeType: b.mimeType, _omitted: true }
      }
      return block
    })
  }

  // Tool call arguments / results often hold the worst offenders.
  if (Array.isArray(next.toolCalls)) {
    next.toolCalls = next.toolCalls.map((tc) => {
      if (!tc || typeof tc !== 'object') return tc
      const t = tc as Record<string, unknown>
      const out = { ...t }
      if (typeof out.arguments === 'string' && out.arguments.length > MAX_CONTENT_CHARS) {
        out.arguments = out.arguments.slice(0, MAX_CONTENT_CHARS) + '…'
      }
      if (typeof out.result === 'string' && out.result.length > MAX_CONTENT_CHARS) {
        const originalLen = out.result.length
        out.result =
          out.result.slice(0, MAX_CONTENT_CHARS) +
          `\n\n… truncated ${originalLen - MAX_CONTENT_CHARS} characters`
      }
      return out
    })
  }
  if (typeof next.result === 'string' && next.result.length > MAX_CONTENT_CHARS) {
    const originalLen = next.result.length
    next.result =
      next.result.slice(0, MAX_CONTENT_CHARS) +
      `\n\n… truncated ${originalLen - MAX_CONTENT_CHARS} characters`
  }
  if (typeof next.thinking === 'string' && next.thinking.length > MAX_CONTENT_CHARS) {
    next.thinking = next.thinking.slice(0, MAX_CONTENT_CHARS) + '…'
  }

  return next
}
