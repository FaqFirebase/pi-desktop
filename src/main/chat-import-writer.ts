import type { AgentEngineKind } from '../shared/ipc-contracts'
import { IMPORTED_MESSAGE_API, IMPORTED_MESSAGE_MODEL, IMPORTED_MESSAGE_PROVIDER } from '../shared/chat-import'
import type { ImportImage, ImportToolCall, ImportTurn } from './chat-import-turns'

/**
 * Session v3 JSONL lines for imported chats, one writer per engine.
 *
 * Pi and OMP share the record shapes; they differ in the first line (OMP has a
 * fixed-size title slot before the header, Pi names a session with a
 * `session_info` record), in user attribution, and in the built-in tool
 * arguments. A tool result is written as a `toolResult` only while its call is
 * still open in the latest assistant message: a result with no open call breaks
 * the next model request, so it becomes assistant text instead. Text for a
 * result is held while other calls of its batch are open, so it never splits
 * the batch from its results.
 */

export const SESSION_FORMAT_VERSION = 3
export const OMP_TITLE_SLOT_BYTES = 256
export const TOOL_CALL_ID_MAX_LENGTH = 64

const OMP_TITLE_SLOT_VERSION = 1
const OMP_TITLE_SOURCE = 'user'
const OMP_USER_ATTRIBUTION = 'user'
const ENTRY_ID_LENGTH = 8
const HEX_RADIX = 16
const LINE_BREAK_BYTES = 1
const PAD_CHARACTER = ' '
const TOOL_CALL_ID_UNSAFE = /[^A-Za-z0-9_-]/g
const TOOL_CALL_ID_FALLBACK = 'call'
const FIRST_DUPLICATE_SUFFIX = 2
const FIRST_LINE = 1
const MIN_FENCE_LENGTH = 3
const BACKTICK_RUN = /`+/g
const UNKNOWN_TOOL_NAME = 'unknown'
const STOP_REASON_TOOL_USE = 'toolUse'
const STOP_REASON_STOP = 'stop'

// Session content the agent reads, not UI text: English on purpose.
const IMPORTED_TOOL_CALL_LABEL = (name: string): string => `[Imported tool call: ${name}]`
const IMPORTED_TOOL_RESULT_LABEL = (name: string): string => `[Imported tool result: ${name}]`
const IMPORTED_TOOL_ERROR_LABEL = (name: string): string => `[Imported tool result: ${name} (error)]`
const IMAGES_NOT_IMPORTED_NOTE = (count: number): string => `(${count} image(s) not imported)`

const PI_TOOL = { bash: 'bash', read: 'read', edit: 'edit', write: 'write' } as const

export interface ImportSessionHeader {
  sessionId: string
  cwd: string
  /** ISO time the source chat started. */
  startedAt: string
  title: string | null
  /** ISO time of the import, OMP's title `updatedAt`. */
  writtenAt: string
}

export interface SessionRecordWriter {
  /** Lines before the first message: OMP title slot, header, Pi session_info. */
  preamble(): string[]
  /** Zero or more JSONL lines (no trailing \n) for one turn. */
  appendTurn(turn: ImportTurn): string[]
  /** Lines still held after the last turn. */
  finish(): string[]
  /** Message records written so far. */
  readonly messageCount: number
}

function titleSlotJson(title: string, updatedAt: string, pad: string): string {
  return JSON.stringify(
    title
      ? { type: 'title', v: OMP_TITLE_SLOT_VERSION, title, source: OMP_TITLE_SOURCE, updatedAt, pad }
      : { type: 'title', v: OMP_TITLE_SLOT_VERSION, title, updatedAt, pad }
  )
}

/**
 * OMP's first line: the title slot, exactly OMP_TITLE_SLOT_BYTES with its
 * line break. The title is cut by code points to the longest prefix that fits.
 */
export function ompTitleSlotLine(title: string | null, updatedAt: string): string {
  const points = [...(title ?? '')]
  const maxBytes = OMP_TITLE_SLOT_BYTES - LINE_BREAK_BYTES
  const fits = (count: number): boolean => Buffer.byteLength(titleSlotJson(points.slice(0, count).join(''), updatedAt, '')) <= maxBytes
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  const kept = points.slice(0, low).join('')
  const padLength = maxBytes - Buffer.byteLength(titleSlotJson(kept, updatedAt, ''))
  return titleSlotJson(kept, updatedAt, PAD_CHARACTER.repeat(padLength))
}

/** `<start time with [:.] as ->_<session id>.jsonl`, the engines' own file naming. */
export function sessionFileName(startedAt: string, sessionId: string): string {
  return `${startedAt.replace(/[:.]/g, '-')}_${sessionId}.jsonl`
}

interface MappedToolCall {
  name: string
  arguments: Record<string, unknown>
}

/** OMP's read path line selector (`path:5+10`, `path:5-`, `path:1+10`). */
function ompReadPath(path: string, offset: number | undefined, limit: number | undefined): string {
  if (offset !== undefined && limit !== undefined) return `${path}:${offset}+${limit}`
  if (offset !== undefined) return `${path}:${offset}-`
  if (limit !== undefined) return `${path}:${FIRST_LINE}+${limit}`
  return path
}

/** The engine's built-in call for `call`, or null when no built-in fits. */
function mapToolCall(engine: AgentEngineKind, call: ImportToolCall): MappedToolCall | null {
  switch (call.kind) {
    case 'shell':
      return {
        name: PI_TOOL.bash,
        arguments: call.timeoutSeconds === undefined ? { command: call.command } : { command: call.command, timeout: call.timeoutSeconds },
      }
    case 'read':
      if (engine === 'omp') return { name: PI_TOOL.read, arguments: { path: ompReadPath(call.path, call.offset, call.limit) } }
      return {
        name: PI_TOOL.read,
        arguments: {
          path: call.path,
          ...(call.offset === undefined ? {} : { offset: call.offset }),
          ...(call.limit === undefined ? {} : { limit: call.limit }),
        },
      }
    case 'edit': {
      if (engine === 'omp') {
        if (call.edits.length !== 1) return null
        const [edit] = call.edits
        return {
          name: PI_TOOL.edit,
          arguments: {
            path: call.path,
            old_string: edit.oldText,
            new_string: edit.newText,
            ...(edit.replaceAll ? { replace_all: true } : {}),
          },
        }
      }
      if (call.edits.some((edit) => edit.replaceAll)) return null
      return {
        name: PI_TOOL.edit,
        arguments: { path: call.path, edits: call.edits.map(({ oldText, newText }) => ({ oldText, newText })) },
      }
    }
    case 'write':
      return { name: PI_TOOL.write, arguments: { path: call.path, content: call.content } }
    case 'other':
      return null
  }
}

/** `text` in a code fence longer than any backtick run inside it. */
function fenced(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(BACKTICK_RUN), (match) => match[0].length))
  const fence = '`'.repeat(Math.max(MIN_FENCE_LENGTH, longestRun + 1))
  return `${fence}\n${text}\n${fence}`
}

function imageBlocks(images: readonly ImportImage[]): Array<{ type: 'image'; data: string; mimeType: string }> {
  return images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }))
}

function zeroUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

type ContentBlock = Record<string, unknown>

class EngineSessionRecordWriter implements SessionRecordWriter {
  private entryCount = 0
  private lastEntryId: string | null = null
  private written = 0
  private readonly usedCallIds = new Set<string>()
  /** Source call id -> written call id and tool name, for calls the next result may answer. */
  private openCalls = new Map<string, { id: string; name: string }>()
  /** Fallback result texts waiting for the open calls of their batch to close. */
  private heldTexts: string[] = []
  private heldTimestamp = 0
  /** Time of the last record, for a source record with no readable time. */
  private lastTimestamp: number

  constructor(
    private readonly engine: AgentEngineKind,
    private readonly header: ImportSessionHeader,
  ) {
    this.lastTimestamp = Date.parse(header.startedAt)
  }

  get messageCount(): number {
    return this.written
  }

  preamble(): string[] {
    const { sessionId, cwd, startedAt, title, writtenAt } = this.header
    const sessionLine = JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: sessionId, timestamp: startedAt, cwd })
    if (this.engine === 'omp') return [ompTitleSlotLine(title, writtenAt), sessionLine]
    if (title === null) return [sessionLine]
    return [sessionLine, this.entry({ type: 'session_info', timestamp: startedAt, name: title })]
  }

  appendTurn(turn: ImportTurn): string[] {
    if (Number.isFinite(turn.timestamp)) this.lastTimestamp = turn.timestamp
    const timestamp = this.lastTimestamp
    switch (turn.role) {
      case 'user':
        return [...this.finish(), ...this.userMessage(turn.text, turn.images, timestamp)]
      case 'assistant':
        return [...this.finish(), ...this.assistantTurn(turn, timestamp)]
      case 'tool-result':
        return this.toolResult(turn, timestamp)
    }
  }

  finish(): string[] {
    if (this.heldTexts.length === 0) return []
    const content = this.heldTexts.map((text) => ({ type: 'text', text }))
    this.heldTexts = []
    // A message between a call and its result orphans the call, so no call stays open.
    this.openCalls.clear()
    return [this.assistantMessage(content, STOP_REASON_STOP, this.heldTimestamp)]
  }

  private userMessage(text: string, images: readonly ImportImage[], timestamp: number): string[] {
    this.openCalls.clear()
    const content: ContentBlock[] = [...(text ? [{ type: 'text', text }] : []), ...imageBlocks(images)]
    if (content.length === 0) return []
    const message = this.engine === 'omp'
      ? { role: 'user', content, attribution: OMP_USER_ATTRIBUTION, timestamp }
      : { role: 'user', content, timestamp }
    return [this.message(message, timestamp)]
  }

  private assistantTurn(turn: Extract<ImportTurn, { role: 'assistant' }>, timestamp: number): string[] {
    const content: ContentBlock[] = []
    const opened = new Map<string, { id: string; name: string }>()
    let endsWithToolCall = false
    for (const block of turn.blocks) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
        endsWithToolCall = false
        continue
      }
      const mapped = mapToolCall(this.engine, block.call)
      if (!mapped) {
        content.push({ type: 'text', text: `${IMPORTED_TOOL_CALL_LABEL(block.call.sourceName)}\n${fenced(block.call.sourceInput)}` })
        endsWithToolCall = false
        continue
      }
      const id = this.uniqueCallId(block.id)
      opened.set(block.id, { id, name: mapped.name })
      content.push({ type: 'toolCall', id, name: mapped.name, arguments: mapped.arguments })
      endsWithToolCall = true
    }
    if (content.length === 0) return []
    const line = this.assistantMessage(content, endsWithToolCall ? STOP_REASON_TOOL_USE : STOP_REASON_STOP, timestamp)
    this.openCalls = opened
    return [line]
  }

  private toolResult(turn: Extract<ImportTurn, { role: 'tool-result' }>, timestamp: number): string[] {
    const open = this.openCalls.get(turn.id)
    if (open) {
      this.openCalls.delete(turn.id)
      const content: ContentBlock[] = [{ type: 'text', text: turn.text }, ...imageBlocks(turn.images)]
      const line = this.message(
        { role: 'toolResult', toolCallId: open.id, toolName: open.name, content, isError: turn.isError, timestamp },
        timestamp,
      )
      return this.openCalls.size === 0 ? [line, ...this.finish()] : [line]
    }
    const name = turn.call?.sourceName ?? UNKNOWN_TOOL_NAME
    const label = turn.isError ? IMPORTED_TOOL_ERROR_LABEL(name) : IMPORTED_TOOL_RESULT_LABEL(name)
    const note = turn.images.length > 0 ? `\n${IMAGES_NOT_IMPORTED_NOTE(turn.images.length)}` : ''
    if (this.heldTexts.length === 0) this.heldTimestamp = timestamp
    this.heldTexts.push(`${label}\n${fenced(turn.text)}${note}`)
    return this.openCalls.size === 0 ? this.finish() : []
  }

  private assistantMessage(content: ContentBlock[], stopReason: string, timestamp: number): string {
    return this.message(
      {
        role: 'assistant',
        content,
        api: IMPORTED_MESSAGE_API,
        provider: IMPORTED_MESSAGE_PROVIDER,
        model: IMPORTED_MESSAGE_MODEL,
        usage: zeroUsage(),
        stopReason,
        timestamp,
      },
      timestamp,
    )
  }

  /** Characters outside [A-Za-z0-9_-] become `_`, cut to the max length, `_2`, `_3`, ... on a clash. */
  private uniqueCallId(sourceId: string): string {
    const base = sourceId.replace(TOOL_CALL_ID_UNSAFE, '_').slice(0, TOOL_CALL_ID_MAX_LENGTH) || TOOL_CALL_ID_FALLBACK
    let id = base
    for (let suffix = FIRST_DUPLICATE_SUFFIX; this.usedCallIds.has(id); suffix++) {
      const tail = `_${suffix}`
      id = `${base.slice(0, TOOL_CALL_ID_MAX_LENGTH - tail.length)}${tail}`
    }
    this.usedCallIds.add(id)
    return id
  }

  private message(message: Record<string, unknown>, timestamp: number): string {
    this.written++
    return this.entry({ type: 'message', timestamp: new Date(timestamp).toISOString(), message })
  }

  /** A record with the next entry id, chained to the previous entry. */
  private entry(fields: { type: string; timestamp: string } & Record<string, unknown>): string {
    this.entryCount++
    const id = this.entryCount.toString(HEX_RADIX).padStart(ENTRY_ID_LENGTH, '0')
    const { type, ...rest } = fields
    const line = JSON.stringify({ type, id, parentId: this.lastEntryId, ...rest })
    this.lastEntryId = id
    return line
  }
}

export function createSessionRecordWriter(engine: AgentEngineKind, header: ImportSessionHeader): SessionRecordWriter {
  return new EngineSessionRecordWriter(engine, header)
}
