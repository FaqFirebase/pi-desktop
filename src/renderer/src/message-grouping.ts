import type { DisplayMessage } from './store'

// Map common Pi tool names to a friendly, user-facing label; falls back to the
// raw name so custom/unknown tools still show something. Keyword matching
// mirrors toolIcon() so the label and icon stay in sync.
export function toolLabel(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('terminal')) return 'Run command'
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'Search'
  if (n.includes('web') || n.includes('fetch') || n.includes('http') || n.includes('url')) return 'Fetch URL'
  if (n.includes('edit') || n.includes('replace') || n.includes('patch')) return 'Edit file'
  if (n.includes('write') || n.includes('create')) return 'Write file'
  if (n.includes('list') || n.startsWith('ls') || n.includes('tree') || n.includes('dir')) return 'List files'
  if (n.includes('read') || n.includes('view') || n.includes('cat') || n.includes('file')) return 'Read file'
  return name
}

// A single chat item to render: either a lone message or a collapsed group of
// consecutive tool-activity messages.
export type ChatRenderItem =
  | { kind: 'message'; message: DisplayMessage }
  | { kind: 'toolGroup'; id: string; title: string; messages: DisplayMessage[] }

// Group a run only once it holds this many tool calls; a lone call renders as-is.
const MIN_GROUP_TOOL_CALLS = 2

// "Tool activity" is anything with no user-facing prose: tool results, and
// assistant turns whose only body is tool calls and/or thinking (no text). A run
// of these between two prose turns is what gets folded into one group; the
// thinking turns ride along and render in the expanded body per the setting.
function isToolActivity(m: DisplayMessage): boolean {
  if (m.role === 'toolResult') return true
  if (m.role === 'assistant') return m.content.trim().length === 0
  return false
}

// Past-tense verb + object noun for each canonical tool label, used to phrase
// both single-operation labels ("Fetched <url>") and group titles ("Fetched 3
// URLs"). `argKeys` are the argument fields a single-op label pulls its shown
// value from (empty = show no value, e.g. commands).
interface ToolVerb {
  verb: string // past tense, capitalized
  noun: string // singular object noun
  nounPlural: string
  argKeys: string[]
}

const TOOL_VERBS: Record<string, ToolVerb> = {
  'Fetch URL': { verb: 'Fetched', noun: 'URL', nounPlural: 'URLs', argKeys: ['url', 'uri', 'href', 'link'] },
  'Read file': { verb: 'Read', noun: 'file', nounPlural: 'files', argKeys: ['path', 'file', 'filename', 'file_path', 'filepath'] },
  'Run command': { verb: 'Ran', noun: 'command', nounPlural: 'commands', argKeys: [] },
  'Edit file': { verb: 'Edited', noun: 'file', nounPlural: 'files', argKeys: ['path', 'file', 'filename', 'file_path', 'filepath'] },
  'Write file': { verb: 'Created', noun: 'file', nounPlural: 'files', argKeys: ['path', 'file', 'filename', 'file_path', 'filepath'] },
  Search: { verb: 'Searched', noun: 'query', nounPlural: 'queries', argKeys: ['query', 'pattern', 'text', 'search', 'q', 'regex'] },
  'List files': { verb: 'Listed', noun: 'location', nounPlural: 'locations', argKeys: ['path', 'dir', 'directory', 'location', 'folder'] },
}

// Fallback for custom/unknown tools so mixed or unknown runs still read sensibly.
const GENERIC_VERB: ToolVerb = { verb: 'Ran', noun: 'tool', nounPlural: 'tools', argKeys: [] }

const MAX_ARG_LEN = 60

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

function shorten(s: string): string {
  return s.length > MAX_ARG_LEN ? s.slice(0, MAX_ARG_LEN - 1) + '…' : s
}

// Pull the value a single-op label should show from the tool call's arguments.
function extractArg(v: ToolVerb, argumentsJson: string): string | null {
  if (v.argKeys.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  for (const key of v.argKeys) {
    const val = obj[key]
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return null
}

// Path-like args show just the basename; URLs/queries show in full (shortened).
function displayArg(label: string, raw: string): string {
  const pathLike =
    label === 'Read file' || label === 'Edit file' || label === 'Write file' || label === 'List files'
  if (pathLike) {
    const base = raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    return shorten(base || raw)
  }
  return shorten(raw)
}

/**
 * Label for a single tool-call badge: past-tense verb plus the operated-on value,
 * e.g. "Fetched https://…", "Read config.ts", "Ran a command". Falls back to a
 * value-less "<Verb> a <noun>" when the argument can't be read, and to the raw
 * label for unknown tools.
 */
export function toolCallLabel(name: string, argumentsJson: string): string {
  const label = toolLabel(name)
  const v = TOOL_VERBS[label]
  if (!v) return label
  const arg = extractArg(v, argumentsJson)
  return arg ? `${v.verb} ${displayArg(label, arg)}` : `${v.verb} a ${v.noun}`
}

// Combine the per-tool verbs across a run into one title, e.g.
// "Fetched 4 URLs, read 2 files, edited a file". Counts are bucketed by canonical
// label in first-appearance order; the leading verb is capitalized, the rest
// lower-cased. Unknown tools bucket together under the generic verb.
function groupTitle(run: DisplayMessage[]): string {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const m of run) {
    for (const tc of m.toolCalls ?? []) {
      const label = toolLabel(tc.name)
      const key = TOOL_VERBS[label] ? label : '__generic__'
      if (!counts.has(key)) order.push(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  return order
    .map((key, i) => {
      const v = key === '__generic__' ? GENERIC_VERB : TOOL_VERBS[key]
      const n = counts.get(key) ?? 0
      const verb = i === 0 ? v.verb : lowerFirst(v.verb)
      const quantity = n === 1 ? `a ${v.noun}` : `${n} ${v.nounPlural}`
      return `${verb} ${quantity}`
    })
    .join(', ')
}

/**
 * Fold consecutive tool-activity messages into collapsible groups. A run that
 * carries fewer than MIN_GROUP_TOOL_CALLS tool calls is emitted as individual
 * messages (unchanged rendering); larger runs become a single `toolGroup` item.
 * Prose turns (assistant text, user, system) always render on their own and act
 * as run boundaries.
 */
export function groupToolMessages(messages: DisplayMessage[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = []
  let run: DisplayMessage[] = []

  const flush = (): void => {
    if (run.length === 0) return
    const toolCallCount = run.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0)
    if (toolCallCount >= MIN_GROUP_TOOL_CALLS) {
      items.push({
        kind: 'toolGroup',
        id: `group-${run[0].id}`,
        title: groupTitle(run),
        messages: run,
      })
    } else {
      for (const m of run) items.push({ kind: 'message', message: m })
    }
    run = []
  }

  for (const m of messages) {
    if (isToolActivity(m)) {
      run.push(m)
    } else {
      flush()
      items.push({ kind: 'message', message: m })
    }
  }
  flush()

  return items
}

// Tool labels whose call operates on a file/location we can resolve from args.
const FILE_LABELS = new Set(['Read file', 'Write file', 'Edit file', 'List files'])

/** The file/location a read/write/edit/list tool call operates on, or null. */
export function toolCallFile(name: string, argumentsJson: string): string | null {
  const label = toolLabel(name)
  if (!FILE_LABELS.has(label)) return null
  const v = TOOL_VERBS[label]
  return v ? extractArg(v, argumentsJson) : null
}

export function baseName(path: string): string {
  return (path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path).toLowerCase()
}

// One replacement in an edit tool call: old text swapped for new.
export interface EditBlock {
  oldText: string
  newText: string
}

/** The edit blocks from an edit tool call's arguments (`{ edits: [...] }`), or null. */
export function parseEdits(argumentsJson: string): EditBlock[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return null
  }
  const edits = (parsed as { edits?: unknown } | null)?.edits
  if (!Array.isArray(edits)) return null
  const blocks: EditBlock[] = []
  for (const e of edits) {
    if (e && typeof e === 'object' && typeof (e as EditBlock).oldText === 'string' && typeof (e as EditBlock).newText === 'string') {
      blocks.push({ oldText: (e as EditBlock).oldText, newText: (e as EditBlock).newText })
    }
  }
  return blocks.length > 0 ? blocks : null
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length)

/** Added/removed line totals across an edit's blocks (old lines out, new lines in). */
export function editStats(blocks: EditBlock[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const b of blocks) {
    removed += lineCount(b.oldText)
    added += lineCount(b.newText)
  }
  return { added, removed }
}

// Pi appends a footer to a truncated read, e.g.
// "[262 more lines in file. Use offset=21 to continue.]". Match it so it can be
// shown as a note rather than syntax-highlighted as code.
const READ_TRUNCATION_RE = /^\[\d+ more lines? in file\b.*\]$/

/**
 * Split a read result's trailing truncation footer (if any) from the file
 * content, so the footer isn't highlighted as code. Trailing blank lines between
 * the content and the footer are dropped with it.
 */
export function splitReadTruncationNote(content: string): { code: string; note: string | null } {
  const lines = content.split('\n')
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last--
  if (last < 0 || !READ_TRUNCATION_RE.test(lines[last].trim())) return { code: content, note: null }
  const note = lines[last].trim()
  let end = last - 1
  while (end >= 0 && lines[end].trim() === '') end--
  return { code: lines.slice(0, end + 1).join('\n'), note }
}

/**
 * Prepare the raw message list for rendering:
 *  - enrich each toolResult with the paired call's `toolName` + operated-on
 *    `toolFile` (so it can highlight file reads / show a diff), matched by id.
 *  - drop follow-up reads of a file edited earlier in the same run (verification
 *    re-reads are noise), matching on basename; their result is dropped too.
 *
 * Runs before grouping. Pure; returns a new array, reusing message objects where
 * nothing changed so memoized bubbles keep stable refs.
 */
export function prepareChatMessages(messages: DisplayMessage[]): DisplayMessage[] {
  // call id -> { name, file }
  const calls = new Map<string, { name: string; file: string | null }>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        calls.set(tc.id, { name: tc.name, file: toolCallFile(tc.name, tc.arguments) })
      }
    }
  }

  // Which read calls to hide: reads of a file edited earlier in the same run.
  const hidden = new Set<string>()
  let edited = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.content.trim() === '' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        const label = toolLabel(tc.name)
        const file = calls.get(tc.id)?.file
        if (label === 'Edit file' && file) edited.add(baseName(file))
        else if (label === 'Read file' && file && edited.has(baseName(file))) hidden.add(tc.id)
      }
    } else if (m.role !== 'toolResult') {
      edited = new Set() // prose/user/system ends the run
    }
  }

  const out: DisplayMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.some((tc) => hidden.has(tc.id))) {
      const kept = m.toolCalls.filter((tc) => !hidden.has(tc.id))
      if (kept.length === 0 && m.content.trim() === '') continue // whole turn was hidden reads
      out.push({ ...m, toolCalls: kept })
    } else if (m.role === 'toolResult' && m.toolCallId) {
      if (hidden.has(m.toolCallId)) continue // drop the hidden read's result
      const paired = calls.get(m.toolCallId)
      out.push(paired ? { ...m, toolName: paired.name, toolFile: paired.file ?? undefined } : m)
    } else {
      out.push(m)
    }
  }
  return out
}
