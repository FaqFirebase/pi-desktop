import { basename } from 'path'
import { isObject } from './ipc/validation'
import { recordTimestamp, type ImportEvent, type ImportImage, type ImportToolCall } from './chat-import-turns'

/**
 * Codex chat files (`<sessions>/YYYY/MM/DD/rollout-*.jsonl`) to import events.
 * A file is one linear history, so every record converts on its own; only
 * `response_item` records hold the chat, everything else is bookkeeping.
 */

export interface CodexSessionMeta {
  id: string
  cwd: string | null
  startedAt: string | null
}

const SESSION_META_TYPE = 'session_meta'
const RESPONSE_ITEM_TYPE = 'response_item'
/** User blocks Codex adds as context, not typed by the user. */
const CONTEXT_PREFIXES = ['<environment_context>', '# AGENTS.md instructions', '<user_instructions>', '<external_codex_apps_open_page>']
const DATA_URL = /^data:([^;,]+);base64,(.*)$/s
const MESSAGE_TEXT_SEPARATOR = '\n\n'
const OUTPUT_TEXT_SEPARATOR = '\n'
const SUCCESS_EXIT_CODE = 0
const MS_PER_SECOND = 1000
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh'])
const SHELL_SCRIPT_FLAGS = new Set(['-c', '-lc'])
const SHELL_SCRIPT_ARGV_LENGTH = 3
const SHELL_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/
const ARGV_SHELL_TOOLS = new Set(['shell', 'container.exec'])
const EXEC_COMMAND_TOOL = 'exec_command'
const APPLY_PATCH_TOOL = 'apply_patch'

const PATCH_BEGIN = '*** Begin Patch'
const PATCH_END = '*** End Patch'
const PATCH_ADD = '*** Add File: '
const PATCH_UPDATE = '*** Update File: '
const PATCH_DELETE = '*** Delete File: '
const PATCH_MOVE = '*** Move to: '
const PATCH_END_OF_FILE = '*** End of File'
const PATCH_HUNK = '@@'
const PATCH_CONTEXT = ' '
const PATCH_REMOVED = '-'
const PATCH_ADDED = '+'
const PATCH_LINE_BREAK = /\r?\n/

export function codexSessionMeta(record: Record<string, unknown>): CodexSessionMeta | null {
  const payload = record.payload
  if (record.type !== SESSION_META_TYPE || !isObject(payload) || typeof payload.id !== 'string') return null
  return {
    id: payload.id,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    startedAt: typeof payload.timestamp === 'string' ? payload.timestamp : null,
  }
}

function dataUrlImage(url: unknown): ImportImage | null {
  const match = typeof url === 'string' ? DATA_URL.exec(url) : null
  return match ? { data: match[2], mimeType: match[1] } : null
}

function blockTexts(blocks: Record<string, unknown>[], types: readonly string[]): string[] {
  return blocks.flatMap((block) => (types.includes(block.type as string) && typeof block.text === 'string' ? [block.text] : []))
}

function blockImages(blocks: Record<string, unknown>[]): ImportImage[] {
  return blocks.flatMap((block) => (block.type === 'input_image' ? dataUrlImage(block.image_url) ?? [] : []))
}

function isContextText(text: string): boolean {
  return CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function messageEvents(payload: Record<string, unknown>, timestamp: number): ImportEvent[] {
  const blocks = Array.isArray(payload.content) ? payload.content.filter(isObject) : []
  if (payload.role === 'user') {
    const text = blockTexts(blocks, ['input_text']).filter((part) => !isContextText(part)).join(MESSAGE_TEXT_SEPARATOR)
    const images = blockImages(blocks)
    return text || images.length > 0 ? [{ kind: 'user', text, images, timestamp }] : []
  }
  if (payload.role === 'assistant') {
    const text = blockTexts(blocks, ['output_text']).join(MESSAGE_TEXT_SEPARATOR)
    return text.trim() ? [{ kind: 'assistant-text', text, timestamp }] : []
  }
  return []
}

function outputEvent(payload: Record<string, unknown>, timestamp: number): ImportEvent[] {
  if (typeof payload.call_id !== 'string') return []
  const base = { kind: 'tool-result' as const, id: payload.call_id, timestamp }
  const output = payload.output
  if (Array.isArray(output)) {
    const blocks = output.filter(isObject)
    return [{ ...base, text: blockTexts(blocks, ['input_text', 'output_text']).join(OUTPUT_TEXT_SEPARATOR), images: blockImages(blocks), isError: false }]
  }
  if (typeof output !== 'string') return []
  const parsed = parseJsonObject(output)
  if (parsed && typeof parsed.output === 'string') {
    const exitCode = isObject(parsed.metadata) ? parsed.metadata.exit_code : undefined
    return [{ ...base, text: parsed.output, images: [], isError: typeof exitCode === 'number' && exitCode !== SUCCESS_EXIT_CODE }]
  }
  return [{ ...base, text: output, images: [], isError: false }]
}

export function codexRecordEvents(record: Record<string, unknown>): ImportEvent[] {
  const payload = record.payload
  if (record.type !== RESPONSE_ITEM_TYPE || !isObject(payload)) return []
  const timestamp = recordTimestamp(record)
  switch (payload.type) {
    case 'message':
      return messageEvents(payload, timestamp)
    case 'function_call':
    case 'custom_tool_call': {
      const isCustom = payload.type === 'custom_tool_call'
      const input = isCustom ? payload.input : payload.arguments
      if (typeof payload.call_id !== 'string' || typeof payload.name !== 'string' || typeof input !== 'string') return []
      return [{ kind: 'tool-call', id: payload.call_id, call: codexToolCall(payload.name, input, isCustom), timestamp }]
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      return outputEvent(payload, timestamp)
    default:
      // Reasoning is encrypted or a summary; the rest is bookkeeping.
      return []
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function quoteShellArg(arg: string): string {
  return SHELL_SAFE_ARG.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** A shell line for an argv: the script of `bash -lc <script>`, else the quoted args. */
export function shellCommandFromArgv(argv: readonly string[]): string {
  if (argv.length === SHELL_SCRIPT_ARGV_LENGTH && SHELL_NAMES.has(basename(argv[0])) && SHELL_SCRIPT_FLAGS.has(argv[1])) return argv[2]
  return argv.map(quoteShellArg).join(' ')
}

export function codexToolCall(name: string, rawInput: string, isCustom: boolean): ImportToolCall {
  const source = { sourceName: name, sourceInput: rawInput }
  const other: ImportToolCall = { kind: 'other', ...source }
  if (name === APPLY_PATCH_TOOL && isCustom) return patchToolCall(rawInput, name)
  const args = isCustom ? null : parseJsonObject(rawInput)
  if (!args) return other

  if (ARGV_SHELL_TOOLS.has(name)) {
    const { command, timeout_ms: timeoutMs } = args
    if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string')) return other
    if (timeoutMs !== undefined && typeof timeoutMs !== 'number') return other
    const shellCommand = shellCommandFromArgv(command)
    return timeoutMs === undefined
      ? { kind: 'shell', command: shellCommand, ...source }
      : { kind: 'shell', command: shellCommand, timeoutSeconds: Math.ceil(timeoutMs / MS_PER_SECOND), ...source }
  }
  if (name === EXEC_COMMAND_TOOL && typeof args.cmd === 'string') return { kind: 'shell', command: args.cmd, ...source }
  if (name === APPLY_PATCH_TOOL && typeof args.input === 'string') return { ...patchToolCall(args.input, name), sourceInput: rawInput }
  return other
}

/** Hunks of an update section: each `@@` line starts one; lines before the first are hunk 1. */
function patchHunks(lines: readonly string[]): Array<{ oldText: string; newText: string; replaceAll: boolean }> {
  const hunks: string[][] = [[]]
  for (const line of lines) {
    if (line.startsWith(PATCH_HUNK)) hunks.push([])
    else if (line !== PATCH_END_OF_FILE) hunks[hunks.length - 1].push(line)
  }
  return hunks
    .filter((hunk) => hunk.length > 0)
    .map((hunk) => {
      const oldLines: string[] = []
      const newLines: string[] = []
      for (const line of hunk) {
        // A blank line in a patch is an empty context line.
        const marker = line.charAt(0) || PATCH_CONTEXT
        const text = line.slice(1)
        if (marker === PATCH_CONTEXT || marker === PATCH_REMOVED) oldLines.push(text)
        if (marker === PATCH_CONTEXT || marker === PATCH_ADDED) newLines.push(text)
      }
      return { oldText: oldLines.join('\n'), newText: newLines.join('\n'), replaceAll: false }
    })
}

/** A one-file patch as a write (new file) or an edit (one edit per hunk); anything else stays other. */
export function patchToolCall(patch: string, sourceName: string): ImportToolCall {
  const other: ImportToolCall = { kind: 'other', sourceName, sourceInput: patch }
  const lines = patch.split(PATCH_LINE_BREAK)
  const begin = lines.indexOf(PATCH_BEGIN)
  const end = lines.indexOf(PATCH_END, begin + 1)
  if (begin === -1 || end === -1) return other

  const body = lines.slice(begin + 1, end)
  const sections = body.filter((line) => [PATCH_ADD, PATCH_UPDATE, PATCH_DELETE].some((prefix) => line.startsWith(prefix)))
  if (sections.length !== 1 || !body[0]?.startsWith(sections[0])) return other
  const [header, ...rest] = body
  const source = { sourceName, sourceInput: patch }

  if (header.startsWith(PATCH_ADD)) {
    const content = rest.filter((line) => line.startsWith(PATCH_ADDED)).map((line) => line.slice(1))
    return { kind: 'write', path: header.slice(PATCH_ADD.length), content: `${content.join('\n')}\n`, ...source }
  }
  if (header.startsWith(PATCH_UPDATE) && !rest[0]?.startsWith(PATCH_MOVE)) {
    const edits = patchHunks(rest)
    if (edits.length === 0) return other
    return { kind: 'edit', path: header.slice(PATCH_UPDATE.length), edits, ...source }
  }
  return other
}

/** Latest thread_name per session id from session_index.jsonl lines. */
export function codexTitlesFromIndex(lines: Iterable<string>): Map<string, string> {
  const titles = new Map<string, string>()
  for (const line of lines) {
    const entry = line.trim() ? parseJsonObject(line) : null
    if (entry && typeof entry.id === 'string' && typeof entry.thread_name === 'string' && entry.thread_name.trim()) {
      titles.set(entry.id, entry.thread_name.trim())
    }
  }
  return titles
}
