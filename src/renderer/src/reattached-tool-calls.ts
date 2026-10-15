import type { DisplayMessage } from './message-parsing'

/**
 * Returning to a session mid-turn loads its saved history, where a tool that
 * is still running has a call but no result yet, and the live stream missed
 * that tool's start. Mark the calls of the current turn that have no result as
 * running, so their cards say so instead of looking finished.
 */
export function markUnansweredToolCallsRunning(messages: DisplayMessage[]): DisplayMessage[] {
  const answered = new Set(messages.filter((message) => message.role === 'toolResult').map((message) => message.toolCallId))
  const turnStart = messages.map((message) => message.role).lastIndexOf('user')
  let changed = false
  const next = messages.map((message, index) => {
    if (index < turnStart || message.role !== 'assistant' || !message.toolCalls) return message
    const toolCalls = message.toolCalls.map((call) => {
      if (answered.has(call.id) || call.result !== undefined || call.isError !== undefined) return call
      changed = true
      return { ...call, isExecuting: true }
    })
    return toolCalls.some((call, i) => call !== message.toolCalls![i]) ? { ...message, toolCalls } : message
  })
  return changed ? next : messages
}

/** A running call marked by markUnansweredToolCallsRunning finished; show its outcome. */
export function settleRunningToolCall(messages: DisplayMessage[], toolCallId: string, isError: boolean): DisplayMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || !message.toolCalls?.some((call) => call.id === toolCallId && call.isExecuting)) return message
    changed = true
    return {
      ...message,
      toolCalls: message.toolCalls.map((call) => call.id === toolCallId ? { ...call, isExecuting: false, isError } : call),
    }
  })
  return changed ? next : messages
}
