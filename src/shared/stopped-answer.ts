/** Stop reason Pi and OMP record for an answer the user interrupted. */
const STOPPED_BY_USER = 'aborted'

/** An assistant answer the user stopped before it finished. */
export function isStoppedAnswer(message: Record<string, unknown> | undefined): message is Record<string, unknown> {
  return message?.role === 'assistant' && message.stopReason === STOPPED_BY_USER
}
