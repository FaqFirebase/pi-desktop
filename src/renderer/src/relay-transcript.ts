/**
 * Converts a relay session transcript into the same display model the local
 * session path produces.
 *
 * A remote session should not get its own renderer: the moment it does, every
 * future message feature has to be built twice. So relay events are translated
 * into `DisplayMessage` and handed to the ordinary chat components, and the only
 * thing that differs is where the bytes came from.
 */
import type { RelaySessionEvent } from '../../shared/relay-protocol'
import type { DisplayMessage } from './message-parsing'

/** Shapes the Pi emits inside `session_history.events`; unknown kinds are skipped. */
interface RelayUserInput {
  type: 'user_input'
  ts?: number
  id?: string
  text?: string
}

interface RelayAgentMessage {
  type: 'agent_message'
  ts?: number
  in_reply_to?: string
  text?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface RelayToolRequest {
  type: 'tool_request'
  ts?: number
  tool_call_id?: string
  tool?: string
  args?: unknown
}

interface RelayToolResult {
  type: 'tool_result'
  ts?: number
  tool_call_id?: string
  tool?: string
  result?: unknown
  is_error?: boolean
}

/** One decoded relay event. Declared as a union so the switch narrows cleanly. */
type RelayEvent = RelayUserInput | RelayAgentMessage | RelayToolRequest | RelayToolResult

/**
 * Turns a tool result into text.
 *
 * The value is `unknown` on the wire because different Pi tools return different
 * shapes; a string is used as-is, anything else is JSON so the user sees the
 * structure rather than `[object Object]`.
 */
/**
 * Serialises tool arguments for display.
 *
 * Returns `{}` when the value cannot be serialised (a cycle, a BigInt): the call
 * still has to render, and a bare `{}` says "no arguments shown" rather than
 * hiding the call entirely.
 */
function stringifyArgs(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Converts relay events into display messages, in wire order.
 *
 * Tool results are attached to the call they answer where one exists, which is
 * what makes a remote transcript look like a local one: the local path renders a
 * tool call with its result attached rather than as two separate bubbles.
 */
export function relayEventsToDisplayMessages(events: RelaySessionEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  /** Tool calls by id, so a later tool_result can attach instead of appending. */
  const callsById = new Map<string, DisplayMessage>()

  for (const raw of events) {
    // The wire type is open-ended (`[key: string]: unknown`), so this cast is
    // narrowing to the kinds we render, not widening away real structure.
    const event = raw as RelayEvent
    const timestamp = typeof event.ts === 'number' && event.ts > 0 ? event.ts : Date.now()

    switch (event.type) {
      case 'user_input': {
        const text = typeof event.text === 'string' ? event.text : ''
        if (!text) break
        messages.push({
          id: typeof event.id === 'string' && event.id ? event.id : `remote-user-${timestamp}-${messages.length}`,
          role: 'user',
          content: text,
          timestamp,
        })
        break
      }

      case 'agent_message': {
        const text = typeof event.text === 'string' ? event.text : ''
        if (!text) break
        messages.push({
          id: `remote-agent-${timestamp}-${messages.length}`,
          role: 'assistant',
          content: text,
          timestamp,
        })
        break
      }

      case 'tool_request': {
        const callId = typeof event.tool_call_id === 'string' ? event.tool_call_id : ''
        const name = typeof event.tool === 'string' ? event.tool : 'tool'
        // A tool arg that cannot be serialised (a cycle, a BigInt) still has to
        // render as *something*; `{}` is a truthful "could not show this".
        const args = stringifyArgs(event.args)
        const message: DisplayMessage = {
          id: `remote-tool-${callId || timestamp}-${messages.length}`,
          role: 'assistant',
          content: '',
          timestamp,
          toolCalls: [{ id: callId, name, arguments: args }],
        }
        messages.push(message)
        if (callId) callsById.set(callId, message)
        break
      }

      case 'tool_result': {
        const callId = typeof event.tool_call_id === 'string' ? event.tool_call_id : ''
        const result = stringifyResult(event.result)
        const isError = event.is_error === true
        const owner = callId ? callsById.get(callId) : undefined
        const call = owner?.toolCalls?.[0]
        if (call) {
          call.result = result
          call.isError = isError
          call.isExecuting = false
          break
        }
        // No matching call in this window of history (the Pi truncates history,
        // so a result can outlive its call). Show it standalone rather than
        // dropping real output.
        messages.push({
          id: `remote-result-${callId || timestamp}-${messages.length}`,
          role: 'toolResult',
          content: result,
          timestamp,
          toolCallId: callId || undefined,
          toolName: typeof event.tool === 'string' ? event.tool : undefined,
          isError,
        })
        break
      }

      default:
        // `compaction`, `usage`, and anything a newer Pi adds: not renderable
        // here, and inventing a bubble would misrepresent the transcript.
        break
    }
  }

  return messages
}
