import {
  NEXT_STEPS_DEVICE_PATH,
  OMP_DEVICE_WRITE_TOOL,
  parseNextStepsToolCall,
  type NextStep,
} from '../../../resources/next-steps'
import type { DisplayMessage } from './message-parsing'

type ToolCall = NonNullable<DisplayMessage['toolCalls']>[number]

/** The call suggests next steps; the chat shows its steps as buttons, never as a tool call. */
export function isNextStepsCall(call: Pick<ToolCall, 'name' | 'arguments'>): boolean {
  return parseNextStepsToolCall(call.name, call.arguments) !== null
}

// The `path` value streamed so far; its closing quote may not have arrived yet.
const PARTIAL_PATH_VALUE = /"path"\s*:\s*"([^"]*)/
// `content` starts like the steps JSON: {"steps" with its quotes escaped.
const STEPS_CONTENT_START = /"content"\s*:\s*"\{\s*\\"steps\\"/

/**
 * For a call whose arguments may still be streaming (partial JSON): it is, or
 * may still turn out to be, a next-steps call. A device write is told apart by
 * its path once the path shows, or by steps-like content before that. A real
 * file write whose start looks the same shows as soon as its path arrives.
 */
export function mayBeNextStepsCall(call: Pick<ToolCall, 'name' | 'arguments'>): boolean {
  if (isNextStepsCall(call)) return true
  if (call.name !== OMP_DEVICE_WRITE_TOOL) return false
  const path = PARTIAL_PATH_VALUE.exec(call.arguments)
  if (path) return path[1].length > 0 && NEXT_STEPS_DEVICE_PATH.startsWith(path[1])
  return STEPS_CONTENT_START.test(call.arguments)
}

/**
 * The messages without next-steps calls and their results. A message that
 * held only such a call is dropped. The same list comes back when nothing
 * was hidden, so memoized rows stay stable.
 */
export function withoutNextStepsCalls(messages: DisplayMessage[]): DisplayMessage[] {
  const hiddenCallIds = new Set<string>()
  const visible: DisplayMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.some(isNextStepsCall)) {
      const toolCalls = message.toolCalls.filter((call) => {
        if (!isNextStepsCall(call)) return true
        hiddenCallIds.add(call.id)
        return false
      })
      if (toolCalls.length === 0 && !message.content.trim() && !message.thinking) continue
      visible.push({ ...message, toolCalls: toolCalls.length > 0 ? toolCalls : undefined })
    } else if (!(message.role === 'toolResult' && message.toolCallId && hiddenCallIds.has(message.toolCallId))) {
      visible.push(message)
    }
  }
  return hiddenCallIds.size > 0 ? visible : messages
}

/**
 * The steps the agent suggested in the latest turn (after the last user
 * message): the last call whose result did not fail. None once the user
 * sends the next message.
 */
export function latestNextSteps(messages: DisplayMessage[]): NextStep[] {
  const failedCallIds = new Set<string>()
  // Results follow their calls, so walking back meets a failed result first.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user') break
    if (message.role === 'toolResult' && message.isError && message.toolCallId) failedCallIds.add(message.toolCallId)
    const calls = message.role === 'assistant' ? message.toolCalls ?? [] : []
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex--) {
      const call = calls[callIndex]
      if (failedCallIds.has(call.id)) continue
      const steps = parseNextStepsToolCall(call.name, call.arguments)
      if (steps && steps.length > 0) return steps
    }
  }
  return []
}
