import { t } from '../../shared/i18n'
import type { PiMessageUpdateEvent, PiRpcEvent, PiToolExecutionStartEvent, PiToolExecutionUpdateEvent, PiToolExecutionEndEvent } from '../../shared/ipc-contracts'
import { parseAgentMessage, type DisplayMessage } from './message-parsing'
import { placeStreamedDelta } from './streamed-delta'
import { stripAnsi } from './utils/strip-ansi'

export interface ChatMessage extends DisplayMessage { sourceId?: string }
export interface ChatToolCall {
  name: string
  args: string
  isExecuting: boolean
  result?: string
  isError?: boolean
  startedAt?: number
  durationMs?: number
}

export function parseChatMessage(raw: unknown): ChatMessage | null {
  const message = parseAgentMessage(raw)
  if (!message) return null
  const id = (raw as Record<string, unknown>).id
  return { ...message, sourceId: id == null ? undefined : String(id) }
}

export function parseChatMessages(raw: unknown[]): ChatMessage[] {
  return raw.flatMap((item) => {
    const message = parseChatMessage(item)
    return message ? [message] : []
  })
}

function messageKey(message: DisplayMessage): string {
  return JSON.stringify([message.role, message.timestamp, message.content, message.thinking, message.toolCallId, message.toolCalls?.map((tool) => tool.id)])
}

/** Reconcile snapshots and live commits without collapsing repeated engine messages. */
export function mergeChatMessages(history: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const ids = new Set(history.map((message) => message.id))
  const liveIds = new Set(live.map((message) => message.id))
  const fallback = new Map<string, number>()
  const identified = new Map<string, number>()
  for (const message of history) {
    if (liveIds.has(message.id)) continue
    const counts = message.sourceId === undefined ? fallback : identified
    const key = messageKey(message)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const consume = (counts: Map<string, number>, key: string): boolean => {
    const count = counts.get(key) ?? 0
    if (!count) return false
    counts.set(key, count - 1)
    return true
  }
  return [...history, ...live.filter((message) => {
    if (ids.has(message.id)) return false
    const key = messageKey(message)
    if (consume(fallback, key)) return false
    return message.sourceId !== undefined || !consume(identified, key)
  })]
}

/** Preserve local render identity on an idle backfill, matching each occurrence once. */
export function retainChatMessageIdentity(history: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  const byId = new Map(previous.map((message) => [message.sourceId ?? message.id, message]))
  const key = (message: ChatMessage): string => JSON.stringify([
    message.role, message.content, message.thinking, message.toolCallId,
    !message.content && !message.thinking ? message.toolCalls?.map((call) => call.id) : undefined,
  ])
  const fallback = new Map<string, ChatMessage[]>()
  const reserved = new Set(history.flatMap((message) => {
    const existing = byId.get(message.sourceId ?? message.id)
    return existing ? [existing] : []
  }))
  for (const message of previous) {
    if (reserved.has(message)) continue
    const identity = key(message)
    const matches = fallback.get(identity) ?? []
    matches.push(message)
    fallback.set(identity, matches)
  }
  return history.map((message) => {
    const matches = fallback.get(key(message))
    const index = matches?.findIndex((existing) => message.sourceId === undefined || existing.sourceId === undefined) ?? -1
    const existing = byId.get(message.sourceId ?? message.id) ?? (index < 0 ? undefined : matches?.splice(index, 1)[0])
    return existing ? { ...message, id: existing.id, initiallyShowThinking: existing.initiallyShowThinking } : message
  })
}

/** Shell-style prompt recall, scoped by the caller to its own session. */
export function appendPromptHistory(history: string[], text: string, cap = 200): string[] {
  const trimmed = text.trim()
  if (!trimmed || history[history.length - 1] === trimmed) return history
  return [...history, trimmed].slice(-cap)
}

export interface ChatStreamState {
  content: string
  thinking: string
  tools: Map<string, ChatToolCall>
}
export interface ChatStreamUpdate extends ChatStreamState { missingPrefix: boolean }

/** Stream placement and tool argument assembly; snapshot/backfill policy stays with the surface. */
export function applyChatStreamUpdate(state: ChatStreamState, event: PiMessageUpdateEvent['assistantMessageEvent'], now = Date.now()): ChatStreamUpdate {
  if (event.type === 'text_delta' || event.type === 'thinking_delta') {
    const field = event.type === 'text_delta' ? 'content' : 'thinking'
    const placed = placeStreamedDelta(state[field], event.delta ?? '', event.offset)
    return { ...state, ...(placed === null ? {} : { [field]: placed }), missingPrefix: placed === null }
  }
  const partial = event.partial?.content
  const call = event.toolCall ?? (Array.isArray(partial) && event.contentIndex !== undefined
    ? partial[event.contentIndex] as Record<string, unknown> | undefined : undefined)
  if (!call?.id || !['toolcall_start', 'toolcall_delta', 'toolcall_end'].includes(event.type)) return { ...state, missingPrefix: false }
  const id = String(call.id)
  const existing = state.tools.get(id)
  const name = existing?.name ?? String(call.name ?? 'unknown')
  const tool: ChatToolCall = existing ?? { name, args: '', isExecuting: true, startedAt: now }
  const next = event.type === 'toolcall_delta'
    ? { ...tool, name, args: tool.args + (event.delta ?? '') }
    : event.type === 'toolcall_end'
      ? { ...tool, name, args: call.arguments === undefined ? tool.args : JSON.stringify(call.arguments) }
      : { ...tool, name }
  const tools = new Map(state.tools)
  tools.set(id, next)
  return { ...state, tools, missingPrefix: false }
}

type ToolExecutionEvent = PiToolExecutionStartEvent | PiToolExecutionUpdateEvent | PiToolExecutionEndEvent
export function applyChatToolExecution(tools: Map<string, ChatToolCall>, event: ToolExecutionEvent, now = Date.now()): Map<string, ChatToolCall> {
  const existing = tools.get(event.toolCallId)
  const next = new Map(tools)
  if (event.type === 'tool_execution_start') {
    next.set(event.toolCallId, { name: event.toolName, args: JSON.stringify(event.args), isExecuting: true, startedAt: now })
  } else {
    const result = (event.type === 'tool_execution_update' ? event.partialResult : event.result).content
      .filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
    const tool = existing ?? {
      name: event.toolName, args: event.type === 'tool_execution_update' ? JSON.stringify(event.args) : '', isExecuting: true,
    }
    next.set(event.toolCallId, {
      ...tool, result: result || tool.result,
      ...(event.type === 'tool_execution_end' ? {
        isExecuting: false, isError: event.isError,
        durationMs: tool.startedAt === undefined ? tool.durationMs : now - tool.startedAt,
      } : {}),
    })
  }
  return next
}

// Pi and OMP report a plain user stop with exactly these texts; anything else
// on an aborted turn is a specific reason worth showing (mirrors Pi's own TUI).
// Not translated: they are compared against the engines' own (English)
// output, never shown. The "Stopped" mark already tells the user.
const GENERIC_ABORT_MESSAGES: ReadonlySet<string> = new Set([
  'Request was aborted', // Pi
  'Interrupted by user', // OMP
])

/**
 * Error text to surface in chat for a finished assistant message, or null.
 * A provider that rejects before streaming (e.g. HTTP 402) yields an
 * assistant message with stopReason 'error', empty content, and the provider
 * error in errorMessage — without this, the chat shows nothing at all.
 */
export function turnErrorText(message?: Record<string, unknown>): string | null {
  if (!message || message.role !== 'assistant') return null
  const errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : ''
  if (message.stopReason === 'error') return errorMessage || t('store.messages.unknownError')
  if (message.stopReason === 'aborted' && errorMessage && !GENERIC_ABORT_MESSAGES.has(errorMessage)) {
    return errorMessage
  }
  return null
}

/**
 * The system notice an engine event adds to a chat transcript, or null. Every
 * chat surface shows the same notices, so the wording and rules live here.
 * turn_end re-delivers the ended message, so a turn error surfaces only on
 * message_end.
 */
export function chatEventNotice(event: PiRpcEvent): string | null {
  switch (event.type) {
    case 'message_end': {
      const turnError = turnErrorText(event.message)
      return turnError ? t('store.messages.error', { detail: turnError }) : null
    }
    case 'compaction_start':
      return t('store.messages.compactingContext', { reason: event.reason })
    case 'compaction_end':
      if (event.aborted) return t('store.messages.compactionAborted')
      return event.result ? t('store.messages.contextCompacted') : null
    case 'auto_retry_start':
      return t('store.messages.retrying', { attempt: event.attempt, maxAttempts: event.maxAttempts, detail: event.errorMessage })
    case 'command_output': {
      // OMP writes command output for its terminal UI, colors included.
      const content = typeof event.text === 'string' ? stripAnsi(event.text) : ''
      return content.trim() ? content : null
    }
    default:
      return null
  }
}

/**
 * Put local notices back where they were after a history reload. A notice is
 * never in the engine's history, so a merge appends it after newer messages;
 * this keeps it after the same number of other messages it followed before.
 */
export function keepNoticesInPlace(merged: ChatMessage[], previous: ChatMessage[], isNotice: (message: ChatMessage) => boolean): ChatMessage[] {
  const others = merged.filter((message) => !isNotice(message))
  if (others.length === merged.length) return merged
  const kept = new Set(merged.filter(isNotice).map((message) => message.id))
  const anchors: Array<{ position: number; notice: ChatMessage }> = []
  let position = 0
  for (const message of previous) {
    if (!isNotice(message)) position++
    else if (kept.has(message.id)) anchors.push({ position, notice: message })
  }
  const result = [...others]
  // Insert from the last anchor back, so earlier positions stay valid.
  for (const { position: at, notice } of anchors.reverse()) result.splice(Math.min(at, others.length), 0, notice)
  return result
}
