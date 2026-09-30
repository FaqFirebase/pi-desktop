import type {
  PiMessageUpdateEvent,
  PiToolExecutionEndEvent,
  PiToolExecutionStartEvent,
  PiToolExecutionUpdateEvent,
} from '../ipc-contracts'
import { t } from '../i18n'
import { isStoppedAnswer } from '../stopped-answer'
import { parseAgentMessage, type DisplayMessage } from './message-parsing'
import { splitClaudeCliMarkers } from './claude-cli-markers'
import { settleRunningToolCall } from './reattached-tool-calls'
import {
  aggregateSubagentDetails,
  isSubagentTool,
  subagentAgentName,
  subagentTaskText,
  type SubagentProgress,
} from './subagent-progress'

/** Longest caption kept for a subagent progress row. */
const SUBAGENT_TASK_PREVIEW_CHARS = 120

// Pi and OMP report a plain user stop with exactly these texts; anything else
// on an aborted turn is a specific reason worth showing (mirrors Pi's own TUI).
// Not translated: they are compared against the engines' own (English)
// output, never shown. The "Stopped" mark already tells the user.
const GENERIC_ABORT_MESSAGES: ReadonlySet<string> = new Set([
  'Request was aborted', // Pi
  'Interrupted by user', // OMP
])

export interface StreamingToolCall {
  name: string
  args: string
  result?: string
  isExecuting: boolean
  isError?: boolean
  startedAt?: number
  durationMs?: number
}

/** The part of a chat client's state that Pi's event stream builds up. */
export interface ChatStreamState {
  messages: DisplayMessage[]
  streamingContent: string
  streamingThinking: string
  streamingToolCalls: Map<string, StreamingToolCall>
  subagentProgress: SubagentProgress[]
}

/** Time and ids are injected so the assembly is pure and runs under node:test. */
export interface ChatStreamClock {
  now(): number
  generateId(): string
}

/** The model a client has selected, used when Pi's message names none. */
export interface ActiveModel {
  id?: string
  provider?: string
}

/**
 * The fields to change after one message update, and whether a text or
 * thinking delta started past the end of what this view holds: the view
 * attached in the middle of the message and missed its start. A client
 * fills that gap its own way (the desktop asks main for the text so far).
 */
export interface MessageUpdateResult {
  patch: Partial<ChatStreamState>
  missedStart: boolean
}

export interface TurnCompleteOptions {
  /**
   * True at turn_end, agent_end and when the engine stops: commit the tool
   * calls too. False at an assistant message_end, which comes before its
   * tools execute; their live state stays until the turn ends, so each call
   * is committed only once, with its result.
   */
  completeTools: boolean
  activeModel: ActiveModel | null | undefined
}

const STREAMED_DELTA_FIELDS = {
  text_delta: 'streamingContent',
  thinking_delta: 'streamingThinking',
} as const satisfies Record<string, keyof ChatStreamState>

export function emptyChatStreamState(): ChatStreamState {
  return {
    messages: [],
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
    subagentProgress: [],
  }
}

/**
 * `current` with one streamed delta placed at its offset, or null when the
 * delta starts past the end of `current`: the view attached in the middle of
 * the message and missed its start. A delta `current` already holds (a
 * snapshot covered it) changes nothing; a delta without an offset appends.
 */
export function placeStreamedDelta(current: string, delta: string, offset: number | undefined): string | null {
  if (offset === undefined) return current + delta
  if (offset > current.length) return null
  return offset + delta.length <= current.length ? current : current.slice(0, offset) + delta
}

/**
 * Every function below takes the current state and one Pi event and returns
 * only the fields that change, so a Zustand `set` callback or a plain object
 * merge can apply it. None of them changes the state it is given.
 */
export function applyMessageUpdate(
  state: ChatStreamState,
  event: PiMessageUpdateEvent,
  clock: ChatStreamClock,
): MessageUpdateResult {
  const { assistantMessageEvent } = event
  const unchanged: MessageUpdateResult = { patch: {}, missedStart: false }
  // Start/delta events identify the call by its index in the partial message;
  // only toolcall_end carries the finalized toolCall directly.
  const partialContent = assistantMessageEvent.partial?.content
  const toolCall = assistantMessageEvent.toolCall ?? (
    Array.isArray(partialContent) && assistantMessageEvent.contentIndex !== undefined
      ? partialContent[assistantMessageEvent.contentIndex] as Record<string, unknown> | undefined
      : undefined
  )

  switch (assistantMessageEvent.type) {
    case 'text_delta':
    case 'thinking_delta': {
      const field = STREAMED_DELTA_FIELDS[assistantMessageEvent.type]
      const placed = placeStreamedDelta(state[field], assistantMessageEvent.delta ?? '', assistantMessageEvent.offset)
      if (placed === null) return { patch: {}, missedStart: true }
      return { patch: { [field]: placed }, missedStart: false }
    }

    case 'toolcall_start': {
      if (!toolCall) return unchanged
      const newMap = new Map(state.streamingToolCalls)
      newMap.set(String(toolCall.id ?? ''), {
        name: String(toolCall.name ?? 'unknown'),
        args: '',
        isExecuting: true,
        startedAt: clock.now(),
      })
      return { patch: { streamingToolCalls: newMap }, missedStart: false }
    }

    case 'toolcall_delta': {
      if (!toolCall?.id) return unchanged
      const newMap = new Map(state.streamingToolCalls)
      const existing = newMap.get(String(toolCall.id))
      if (existing) {
        newMap.set(String(toolCall.id), {
          ...existing,
          args: existing.args + (assistantMessageEvent.delta ?? ''),
        })
      }
      return { patch: { streamingToolCalls: newMap }, missedStart: false }
    }

    case 'toolcall_end': {
      if (!toolCall?.id) return unchanged
      const newMap = new Map(state.streamingToolCalls)
      const existing = newMap.get(String(toolCall.id))
      if (existing) {
        newMap.set(String(toolCall.id), {
          ...existing,
          args: JSON.stringify(toolCall.arguments ?? existing.args),
        })
      }
      return { patch: { streamingToolCalls: newMap }, missedStart: false }
    }

    // text_end and thinking_end: the content is finalized in message_end.
    default:
      return unchanged
  }
}

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

/** Commit the stream buffers as an assistant message and clear them. */
export function applyTurnComplete(
  state: ChatStreamState,
  message: Record<string, unknown> | undefined,
  { completeTools, activeModel }: TurnCompleteOptions,
  clock: ChatStreamClock,
): Partial<ChatStreamState> {
  const newMessages = [...state.messages]
  // Final messages contain the full body, including bytes emitted before a
  // mid-turn attach. Deltas alone can only reconstruct the suffix we saw.
  const final = !completeTools && Array.isArray(message?.content) ? parseAgentMessage(message) : null
  const nativeIds = new Set((Array.isArray(message?.content) ? message.content : [])
    .filter((block: Record<string, unknown>) => block?.type === 'toolCall')
    .map((block: Record<string, unknown>) => block.id))
  const pendingTools = new Map(state.streamingToolCalls)
  for (const call of final?.toolCalls ?? []) {
    if (!nativeIds.has(call.id)) continue
    pendingTools.set(call.id, {
      ...pendingTools.get(call.id), name: call.name, args: call.arguments,
      isExecuting: pendingTools.get(call.id)?.isExecuting ?? true,
    })
  }
  const text = final
    ? { content: final.content, toolCalls: (final.toolCalls ?? []).filter((call) => !nativeIds.has(call.id)) }
    : splitClaudeCliMarkers(state.streamingContent, activeModel?.provider)
  const thinking = final ? final.thinking : state.streamingThinking
  // The assistant message ends before its tools execute. Keep their live
  // state until turn_end so each call is committed only once, with its result.
  const entries = completeTools ? Array.from(state.streamingToolCalls.entries()) : []
  // turn_end re-delivers the ended message; only its message_end marks it.
  const stopped = !completeTools && isStoppedAnswer(message)

  // Commit streaming content as assistant message. A stopped answer is kept
  // even when nothing streamed, so its "Stopped" notice still shows.
  if (text.content || thinking || text.toolCalls.length > 0 || entries.length > 0 || stopped) {
    const toolCalls = [
      ...entries.map(([id, tc]) => ({
        id,
        name: tc.name,
        arguments: tc.args,
        result: tc.result,
        isError: tc.isError,
        isExecuting: false,
        durationMs: tc.durationMs,
      })),
      ...text.toolCalls,
    ]

    // Prefer the model/provider Pi records on this specific message (the
    // authoritative source, robust to mid-turn model switches); fall back to
    // the currently-selected model when the event omits them.
    const model = typeof message?.model === 'string' ? message.model : activeModel?.id
    const provider = typeof message?.provider === 'string' ? message.provider : activeModel?.provider
    newMessages.push({
      id: clock.generateId(),
      role: 'assistant',
      content: text.content,
      timestamp: final?.timestamp ?? clock.now(),
      thinking: thinking || undefined,
      initiallyShowThinking: Boolean(state.streamingThinking),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      provider,
      stopped: stopped || undefined,
    })

    for (const [id, tc] of entries) {
      if (!tc.result) continue
      newMessages.push({
        id: `${id}-result`,
        role: 'toolResult',
        content: tc.result,
        timestamp: clock.now(),
        toolCallId: id,
        toolName: tc.name,
      })
    }
  }

  return {
    messages: newMessages.length === state.messages.length ? state.messages : newMessages,
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: completeTools ? new Map() : pendingTools,
    subagentProgress: completeTools ? [] : state.subagentProgress,
  }
}

export function applyToolStart(
  state: ChatStreamState,
  event: PiToolExecutionStartEvent,
  clock: ChatStreamClock,
): Partial<ChatStreamState> {
  const newMap = new Map(state.streamingToolCalls)
  newMap.set(event.toolCallId, {
    name: event.toolName,
    args: JSON.stringify(event.args),
    isExecuting: true,
    startedAt: clock.now(),
  })
  if (!isSubagentTool(event.toolName)) return { streamingToolCalls: newMap }

  const newProgress: SubagentProgress = {
    toolCallId: event.toolCallId,
    agent: subagentAgentName(event.args),
    status: 'running',
    task: subagentTaskText(event.args).slice(0, SUBAGENT_TASK_PREVIEW_CHARS),
    toolCount: 0,
    tokens: 0,
    durationMs: 0,
  }
  return {
    streamingToolCalls: newMap,
    subagentProgress: [...state.subagentProgress, newProgress],
  }
}

function resultText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
}

export function applyToolUpdate(
  state: ChatStreamState,
  event: PiToolExecutionUpdateEvent,
): Partial<ChatStreamState> {
  const text = resultText(event.partialResult.content)

  const newMap = new Map(state.streamingToolCalls)
  const existing = newMap.get(event.toolCallId)
  // A view that attached mid-turn missed the tool's start; the update alone
  // still gives it a live card.
  newMap.set(event.toolCallId, {
    ...(existing ?? { name: event.toolName, args: JSON.stringify(event.args), isExecuting: true }),
    result: text || existing?.result,
  })

  if (isSubagentTool(event.toolName)) {
    const details = event.partialResult.details as Record<string, unknown> | undefined
    const progressList = details?.progress as Array<Record<string, unknown>> | undefined
    const results = details?.results as Array<Record<string, unknown>> | undefined
    if (progressList || results) {
      const newProgress = state.subagentProgress.map((p) => {
        if (p.toolCallId !== event.toolCallId) return p
        return {
          ...p,
          ...aggregateSubagentDetails(p, progressList, results),
        }
      })
      return { streamingToolCalls: newMap, subagentProgress: newProgress }
    }
  }

  return { streamingToolCalls: newMap }
}

export function applyToolEnd(
  state: ChatStreamState,
  event: PiToolExecutionEndEvent,
  clock: ChatStreamClock,
): Partial<ChatStreamState> {
  const text = resultText(event.result.content)

  const newMap = new Map(state.streamingToolCalls)
  const existing = newMap.get(event.toolCallId)
  if (existing) {
    newMap.set(event.toolCallId, {
      ...existing,
      isExecuting: false,
      isError: event.isError,
      result: text || existing.result,
      durationMs: existing.startedAt ? clock.now() - existing.startedAt : existing.durationMs,
    })
  }

  // Finalize subagent progress: mark done and capture final stats
  const newProgress = state.subagentProgress.map((p) => {
    if (p.toolCallId !== event.toolCallId) return p
    const details = isSubagentTool(event.toolName)
      ? (event.result.details as Record<string, unknown> | undefined)
      : undefined
    const progressList = details?.progress as Array<Record<string, unknown>> | undefined
    const results = details?.results as Array<Record<string, unknown>> | undefined
    const agg = aggregateSubagentDetails(p, progressList, results)
    const elapsed =
      agg.durationMs ||
      (p.durationMs > 0 ? p.durationMs : existing?.startedAt ? clock.now() - existing.startedAt : 0)

    return {
      ...p,
      ...agg,
      status: event.isError ? 'error' : 'done',
      durationMs: elapsed,
      currentTool: undefined,
    }
  })

  return {
    streamingToolCalls: newMap,
    subagentProgress: newProgress,
    // A tool that started before a mid-turn return lives only in history.
    ...(existing ? {} : { messages: settleRunningToolCall(state.messages, event.toolCallId, event.isError) }),
  }
}
