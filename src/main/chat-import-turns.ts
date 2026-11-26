/**
 * Neutral chat turns, the shape between a source converter (Claude Code,
 * Codex) and an engine writer (Pi, OMP). Converters emit events per source
 * record; the assembler groups them into turns the writers emit as records.
 */

export interface ImportImage {
  data: string
  mimeType: string
}

/** A source tool call, matched to a built-in tool when one fits. */
export type ImportToolCall =
  | { kind: 'shell'; command: string; timeoutSeconds?: number; sourceName: string; sourceInput: string }
  | { kind: 'read'; path: string; offset?: number; limit?: number; sourceName: string; sourceInput: string }
  | {
      kind: 'edit'
      path: string
      edits: Array<{ oldText: string; newText: string; replaceAll: boolean }>
      sourceName: string
      sourceInput: string
    }
  | { kind: 'write'; path: string; content: string; sourceName: string; sourceInput: string }
  | { kind: 'other'; sourceName: string; sourceInput: string }

export type ImportEvent =
  | { kind: 'user'; text: string; images: ImportImage[]; timestamp: number }
  | { kind: 'assistant-text'; text: string; timestamp: number }
  | { kind: 'tool-call'; id: string; call: ImportToolCall; timestamp: number }
  | { kind: 'tool-result'; id: string; text: string; images: ImportImage[]; isError: boolean; timestamp: number }

export type ImportAssistantBlock = { type: 'text'; text: string } | { type: 'tool'; id: string; call: ImportToolCall }

export type ImportTurn =
  | { role: 'user'; text: string; images: ImportImage[]; timestamp: number }
  | { role: 'assistant'; blocks: ImportAssistantBlock[]; timestamp: number }
  | {
      role: 'tool-result'
      id: string
      call: ImportToolCall | null
      text: string
      images: ImportImage[]
      isError: boolean
      timestamp: number
    }

const JSON_INDENT = 2

/** A source record's ISO `timestamp` in epoch ms; NaN when it has none (the writer then reuses the last time). */
export function recordTimestamp(record: Record<string, unknown>): number {
  return typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
}

/** Serialized tool input for fallback text: the string itself, else pretty JSON. */
export function toolInputText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input, null, JSON_INDENT) ?? ''
}

/**
 * Groups events into turns. Consecutive assistant events make one assistant
 * turn; a user event or a tool result ends it. Each result carries the call
 * it answers, or null when no call with its id was seen.
 */
export class ImportTurnAssembler {
  private pending: Extract<ImportTurn, { role: 'assistant' }> | null = null
  private readonly calls = new Map<string, ImportToolCall>()

  push(event: ImportEvent): ImportTurn[] {
    switch (event.kind) {
      case 'assistant-text':
        this.pendingTurn(event.timestamp).blocks.push({ type: 'text', text: event.text })
        return []
      case 'tool-call':
        this.calls.set(event.id, event.call)
        this.pendingTurn(event.timestamp).blocks.push({ type: 'tool', id: event.id, call: event.call })
        return []
      case 'user':
        return [...this.finish(), { role: 'user', text: event.text, images: event.images, timestamp: event.timestamp }]
      case 'tool-result':
        return [
          ...this.finish(),
          {
            role: 'tool-result',
            id: event.id,
            call: this.calls.get(event.id) ?? null,
            text: event.text,
            images: event.images,
            isError: event.isError,
            timestamp: event.timestamp,
          },
        ]
    }
  }

  /** The assistant turn still open, if any. */
  finish(): ImportTurn[] {
    const pending = this.pending
    this.pending = null
    return pending ? [pending] : []
  }

  private pendingTurn(timestamp: number): Extract<ImportTurn, { role: 'assistant' }> {
    this.pending ??= { role: 'assistant', blocks: [], timestamp }
    return this.pending
  }
}
