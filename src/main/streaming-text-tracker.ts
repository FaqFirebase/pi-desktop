import type { PiMessageUpdateEvent, PiRpcEvent, StreamingTextSnapshot } from '../shared/ipc-contracts'

/** The delta events whose text a view shows while the message streams. */
const STREAMED_TEXT_FIELDS = {
  text_delta: 'content',
  thinking_delta: 'thinking',
} as const satisfies Record<string, keyof StreamingTextSnapshot>

const EMPTY_SNAPSHOT: StreamingTextSnapshot = Object.freeze({ content: '', thinking: '' })

function isAssistantMessageStart(event: PiRpcEvent): boolean {
  return event.type === 'message_start' &&
    (event as { message?: { role?: unknown } }).message?.role === 'assistant'
}

/**
 * The text of the assistant message one Pi process is streaming.
 *
 * Pi sends deltas only, and main forwards the active project's events only, so
 * a view that returns to a project in the middle of a message has missed its
 * start. The tracker stamps each forwarded delta with its offset in the
 * message's text, so the view can tell a delta that follows what it holds from
 * one after a gap, and it answers a snapshot that fills the gap.
 */
export class StreamingTextTracker {
  private snapshotText: StreamingTextSnapshot = EMPTY_SNAPSHOT

  /** Record one event. A text or thinking delta gets its `offset` stamped in place. */
  observe(event: PiRpcEvent): void {
    if (isAssistantMessageStart(event) || event.type === 'message_end' || event.type === 'agent_end') {
      this.reset()
      return
    }
    if (event.type !== 'message_update') return
    const delta = (event as PiMessageUpdateEvent).assistantMessageEvent
    const field = delta ? STREAMED_TEXT_FIELDS[delta.type as keyof typeof STREAMED_TEXT_FIELDS] : undefined
    if (!field) return
    delta.offset = this.snapshotText[field].length
    this.snapshotText = { ...this.snapshotText, [field]: this.snapshotText[field] + (delta.delta ?? '') }
  }

  /** The text and thinking streamed so far in the current message. */
  snapshot(): StreamingTextSnapshot {
    return this.snapshotText
  }

  reset(): void {
    this.snapshotText = EMPTY_SNAPSHOT
  }
}
