/**
 * Whether a session was left mid-turn by the process ending, rather than by the
 * agent finishing or the user stopping it.
 *
 * The GUI is killed for a rebuild, the machine is shut down, and Pi is killed
 * with it. The session file on disk records the work that was lost, and the last
 * record tells us which of three things happened:
 *
 *  - the agent finished (`stop`) — nothing to resume;
 *  - the user stopped it (`aborted`) — resuming would fight the user's decision;
 *  - the turn never ended — a tool call with no result, or a prompt with no
 *    reply — which is the case this module exists to recognise.
 *
 * Kept free of I/O so the classification can be tested directly.
 */

/** One `message` record from a session file, reduced to what the decision needs. */
export interface SessionTailMessage {
  role: string
  stopReason?: string
  /** Tool calls this assistant message requested. */
  toolCallIds?: string[]
  /** The call this tool-result message answers, when the engine records one. */
  toolCallId?: string
}

/** Why a session looks unfinished; `null` when it finished normally. */
export type InterruptedReason = 'tool-call-unanswered' | 'no-reply' | 'errored'

/** Pi writes this for an answer the user interrupted. */
const STOPPED_BY_USER = 'aborted'
/** Pi writes this to request a tool call; the turn continues after the result. */
const REQUIRES_TOOL_RESULT = 'toolUse'

/**
 * Classifies the end of a session.
 *
 * `messages` is the tail of the transcript in file order. Tool results can trail
 * their call by many records, so every result in the window is collected before
 * deciding that a call is unanswered.
 *
 * Returns null when the session ended cleanly, when the user stopped it, or when
 * there is not enough evidence to claim anything.
 */
export function interruptionReason(messages: readonly SessionTailMessage[]): InterruptedReason | null {
  if (messages.length === 0) return null

  // Every tool call answered anywhere in the window. A call whose result sat
  // outside the window reads as unanswered — which is why the caller must give a
  // window wide enough to contain the tail of a turn, not just its last record.
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) answered.add(message.toolCallId)
  }

  const last = messages[messages.length - 1]

  // A prompt that never got any reply: the agent was killed before answering.
  if (last.role === 'user') return 'no-reply'

  // A tool that finished but produced no answer: the turn was between steps when
  // the process ended. Pi only stops on `toolUse` in the middle of a turn, so a
  // trailing result always means an answer was still owed.
  if (last.role === 'toolResult') return 'tool-call-unanswered'

  if (last.role !== 'assistant') return null

  switch (last.stopReason) {
    case STOPPED_BY_USER:
      // The user chose to stop. Continuing would undo an explicit decision.
      return null
    case 'error':
      // The turn ended in an error rather than reaching a stopping point. Worth
      // offering, but not the same as lost work, so it is reported separately.
      return 'errored'
    case REQUIRES_TOOL_RESULT: {
      const pending = (last.toolCallIds ?? []).filter((id) => !answered.has(id))
      return pending.length > 0 ? 'tool-call-unanswered' : null
    }
    default:
      // `stop`, or a reason this version does not know: claim nothing.
      return null
  }
}

/**
 * The prompt to send after resuming, or null when nothing should be sent.
 *
 * Split out from the caller so the decision is testable without a renderer: the
 * failure mode that matters is sending twice, or sending at all when the user
 * stopped the turn or turned the feature off.
 */
export function continuationPrompt(options: {
  reason: InterruptedReason | null
  enabled: boolean
  prompt: string | undefined
  alreadyHandled: boolean
}): string | null {
  if (options.alreadyHandled) return null
  if (!options.enabled) return null
  if (!options.reason) return null
  const prompt = options.prompt?.trim()
  // An empty prompt would send an empty message, which the engine rejects.
  return prompt ? prompt : null
}

/**
 * Extracts the messages a decision needs from parsed session records.
 *
 * Records that are not messages (headers, renames, thinking-level changes,
 * custom widgets) carry no turn state and are dropped here rather than in the
 * classifier, so the classifier reasons about conversation only.
 */
export function tailMessagesFrom(records: readonly unknown[]): SessionTailMessage[] {
  const messages: SessionTailMessage[] = []
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const entry = record as { type?: unknown; message?: unknown }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue
    const message = entry.message as {
      role?: unknown
      stopReason?: unknown
      content?: unknown
    }
    if (typeof message.role !== 'string') continue

    const toolCallIds: string[] = []
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue
        const candidate = block as { type?: unknown; id?: unknown }
        if (candidate.type === 'toolCall' && typeof candidate.id === 'string') toolCallIds.push(candidate.id)
      }
    }

    messages.push({
      role: message.role,
      stopReason: typeof message.stopReason === 'string' ? message.stopReason : undefined,
      ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
      ...(typeof (message as { toolCallId?: unknown }).toolCallId === 'string'
        ? { toolCallId: (message as { toolCallId: string }).toolCallId }
        : {}),
    })
  }
  return messages
}
