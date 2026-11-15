import { isObject } from './ipc/validation'
import { recordTimestamp, toolInputText, type ImportEvent, type ImportImage, type ImportToolCall } from './chat-import-turns'

/**
 * Claude Code chat files (`<projects>/<folder>/<uuid>.jsonl`) to import events.
 *
 * A file is a tree: each record names its parent, a rewind starts a new
 * branch, and side chains belong to subagents. Pass 1 (ClaudeCodeScanner)
 * keeps only an index of uuids and tool ids to find the active branch; pass 2
 * converts the kept lines one at a time, so a huge file is never held whole.
 */

/** Tags Claude Code adds around tool, hook and IDE output; dropped with their content. */
const NOISE_TAGS = [
  'system-reminder',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'task-notification',
  'ide_opened_file',
  'ide_selection',
] as const
const NOISE_TAG_PATTERN = new RegExp(`<(${NOISE_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'g')

/** Claude Code's own marker for messages it made up locally (API errors, interruptions). */
const CLAUDE_CODE_SYNTHETIC_MODEL = '<synthetic>'
const BRANCH_RECORD_TYPES = new Set(['user', 'assistant', 'attachment', 'system'])
const QUEUED_COMMAND_ATTACHMENT = 'queued_command'
const BASE64_SOURCE = 'base64'
const USER_TEXT_SEPARATOR = '\n\n'
const TOOL_RESULT_TEXT_SEPARATOR = '\n'
const MS_PER_SECOND = 1000

interface IndexedRecord {
  line: number
  parentUuid: string | null
  logicalParentUuid: string | null
  isSidechain: boolean
  isUser: boolean
  toolUseIds: string[]
  toolResultIds: string[]
}

export interface ClaudeCodeScanResult {
  keptLines: ReadonlySet<number>
  title: string | null
  cwd: string | null
  startedAt: string | null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function contentBlocks(record: Record<string, unknown>): Record<string, unknown>[] {
  const message = record.message
  if (!isObject(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isObject)
}

function blockIds(blocks: Record<string, unknown>[], type: string, key: string): string[] {
  return blocks.flatMap((block) => (block.type === type && typeof block[key] === 'string' ? [block[key] as string] : []))
}

function trimmedTitle(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Pass 1: feed every parsed record with its 0-based line number; keeps a small index, never content. */
export class ClaudeCodeScanner {
  private readonly records = new Map<string, IndexedRecord>()
  private leaf: string | null = null
  private customTitle: string | null = null
  private aiTitle: string | null = null
  private cwd: string | null = null
  private startedAt: string | null = null

  add(record: Record<string, unknown>, line: number): void {
    if (record.type === 'custom-title') this.customTitle = trimmedTitle(record.customTitle) ?? this.customTitle
    if (record.type === 'ai-title') this.aiTitle = trimmedTitle(record.aiTitle) ?? this.aiTitle
    const isSidechain = record.isSidechain === true
    if (!isSidechain) {
      this.cwd ??= stringOrNull(record.cwd)
      this.startedAt ??= stringOrNull(record.timestamp)
    }
    if (typeof record.uuid !== 'string') return

    const blocks = contentBlocks(record)
    this.records.set(record.uuid, {
      line,
      parentUuid: stringOrNull(record.parentUuid),
      logicalParentUuid: stringOrNull(record.logicalParentUuid),
      isSidechain,
      isUser: record.type === 'user',
      toolUseIds: record.type === 'assistant' ? blockIds(blocks, 'tool_use', 'id') : [],
      toolResultIds: record.type === 'user' ? blockIds(blocks, 'tool_result', 'tool_use_id') : [],
    })
    if (!isSidechain && typeof record.type === 'string' && BRANCH_RECORD_TYPES.has(record.type)) this.leaf = record.uuid
  }

  result(): ClaudeCodeScanResult {
    return {
      keptLines: this.activeBranchLines(),
      title: this.customTitle ?? this.aiTitle,
      cwd: this.cwd,
      startedAt: this.startedAt,
    }
  }

  /** The leaf's parent chain, plus every tool result answering a call on it. */
  private activeBranchLines(): Set<number> {
    const visited = new Set<string>()
    const keptToolUseIds = new Set<string>()
    for (let uuid = this.leaf; uuid !== null && !visited.has(uuid); ) {
      const entry = this.records.get(uuid)
      if (!entry) break
      visited.add(uuid)
      for (const id of entry.toolUseIds) keptToolUseIds.add(id)
      uuid = entry.parentUuid ?? entry.logicalParentUuid
    }
    const lines = new Set<number>()
    for (const [uuid, entry] of this.records) {
      const answersKeptCall = entry.isUser && !entry.isSidechain && entry.toolResultIds.some((id) => keptToolUseIds.has(id))
      if (visited.has(uuid) || answersKeptCall) lines.add(entry.line)
    }
    return lines
  }
}

export function stripClaudeCodeNoise(text: string): string {
  return text.replace(NOISE_TAG_PATTERN, '').trim()
}

function base64Image(block: Record<string, unknown>): ImportImage | null {
  const source = block.source
  if (block.type !== 'image' || !isObject(source) || source.type !== BASE64_SOURCE) return null
  if (typeof source.data !== 'string' || typeof source.media_type !== 'string') return null
  return { data: source.data, mimeType: source.media_type }
}

function images(blocks: Record<string, unknown>[]): ImportImage[] {
  return blocks.flatMap((block) => base64Image(block) ?? [])
}

function texts(blocks: Record<string, unknown>[]): string[] {
  return blocks.flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
}

function userEvent(text: string, eventImages: ImportImage[], timestamp: number): ImportEvent[] {
  return text || eventImages.length > 0 ? [{ kind: 'user', text, images: eventImages, timestamp }] : []
}

function userRecordEvents(record: Record<string, unknown>, timestamp: number): ImportEvent[] {
  const message = record.message
  if (!isObject(message)) return []
  if (typeof message.content === 'string') return userEvent(stripClaudeCodeNoise(message.content), [], timestamp)

  const blocks = contentBlocks(record)
  const results: ImportEvent[] = blocks.flatMap((block): ImportEvent[] => {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return []
    const content = block.content
    const nested = Array.isArray(content) ? content.filter(isObject) : []
    return [
      {
        kind: 'tool-result',
        id: block.tool_use_id,
        text: typeof content === 'string' ? content : texts(nested).join(TOOL_RESULT_TEXT_SEPARATOR),
        images: images(nested),
        isError: block.is_error === true,
        timestamp,
      },
    ]
  })
  const text = texts(blocks).map(stripClaudeCodeNoise).filter(Boolean).join(USER_TEXT_SEPARATOR)
  return [...results, ...userEvent(text, images(blocks), timestamp)]
}

function assistantRecordEvents(record: Record<string, unknown>, timestamp: number): ImportEvent[] {
  if (isObject(record.message) && record.message.model === CLAUDE_CODE_SYNTHETIC_MODEL) return []
  return contentBlocks(record).flatMap((block): ImportEvent[] => {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return [{ kind: 'assistant-text', text: block.text, timestamp }]
    }
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      return [{ kind: 'tool-call', id: block.id, call: claudeCodeToolCall(block.name, block.input), timestamp }]
    }
    // Thinking is tied to the source request; server tools have no local result.
    return []
  })
}

/** Pass 2: the events of one kept record. */
export function claudeCodeRecordEvents(record: Record<string, unknown>): ImportEvent[] {
  if (record.isSidechain === true || record.isMeta === true) return []
  const timestamp = recordTimestamp(record)
  switch (record.type) {
    case 'user':
      return userRecordEvents(record, timestamp)
    case 'assistant':
      return assistantRecordEvents(record, timestamp)
    case 'attachment': {
      const attachment = record.attachment
      if (!isObject(attachment) || attachment.type !== QUEUED_COMMAND_ATTACHMENT || typeof attachment.prompt !== 'string') return []
      return userEvent(stripClaudeCodeNoise(attachment.prompt), [], timestamp)
    }
    default:
      return []
  }
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === 'number'
}

function sourceEdit(value: unknown): { oldText: string; newText: string; replaceAll: boolean } | null {
  if (!isObject(value) || typeof value.old_string !== 'string' || typeof value.new_string !== 'string') return null
  return { oldText: value.old_string, newText: value.new_string, replaceAll: value.replace_all === true }
}

export function claudeCodeToolCall(name: string, input: unknown): ImportToolCall {
  const source = { sourceName: name, sourceInput: toolInputText(input) }
  const other: ImportToolCall = { kind: 'other', ...source }
  if (!isObject(input)) return other
  switch (name) {
    case 'Bash':
      if (typeof input.command !== 'string' || !optionalNumber(input.timeout)) return other
      return input.timeout === undefined
        ? { kind: 'shell', command: input.command, ...source }
        : { kind: 'shell', command: input.command, timeoutSeconds: Math.ceil(input.timeout / MS_PER_SECOND), ...source }
    case 'Read':
      if (typeof input.file_path !== 'string' || !optionalNumber(input.offset) || !optionalNumber(input.limit)) return other
      return {
        kind: 'read',
        path: input.file_path,
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...source,
      }
    case 'Edit': {
      const edit = sourceEdit(input)
      if (typeof input.file_path !== 'string' || !edit) return other
      return { kind: 'edit', path: input.file_path, edits: [edit], ...source }
    }
    case 'MultiEdit': {
      if (typeof input.file_path !== 'string' || !Array.isArray(input.edits) || input.edits.length === 0) return other
      const edits = input.edits.map(sourceEdit).filter((edit) => edit !== null)
      if (edits.length !== input.edits.length) return other
      return { kind: 'edit', path: input.file_path, edits, ...source }
    }
    case 'Write':
      if (typeof input.file_path !== 'string' || typeof input.content !== 'string') return other
      return { kind: 'write', path: input.file_path, content: input.content, ...source }
    default:
      return other
  }
}
