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

// Canonical target of a tool call, for counting distinct operands in a group
// title — the same file read twice, or the same URL fetched twice, is one
// target. Path args normalize separators + case (so `C:\a\b.ts` and `c:/a/b.ts`
// match) and compare on the full path, so a same-named file in two dirs stays
// two targets; other args compare trimmed. A target-less call (a command, or a
// tool whose arg can't be read) has no shared identity: it returns null and the
// caller counts it on its own.
function toolTarget(label: string, v: ToolVerb, argumentsJson: string): string | null {
  const arg = extractArg(v, argumentsJson)
  if (arg === null) return null
  const pathLike =
    label === 'Read file' || label === 'Edit file' || label === 'Write file' || label === 'List files'
  if (pathLike) return arg.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return arg.trim()
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
// label in first-appearance order and count *distinct* targets, so re-reading one
// file or re-fetching one URL reads "Read a file" / "Fetched a URL", not "2".
// Target-less calls (commands, unresolved args) each count on their own. The
// leading verb is capitalized, the rest lower-cased; unknown tools bucket
// together under the generic verb.
function groupTitle(run: DisplayMessage[]): string {
  const order: string[] = []
  const targets = new Map<string, Set<string>>()
  let uniqueSeq = 0 // gives each target-less call its own bucket entry
  for (const m of run) {
    for (const tc of m.toolCalls ?? []) {
      const label = toolLabel(tc.name)
      const key = TOOL_VERBS[label] ? label : '__generic__'
      if (!targets.has(key)) {
        order.push(key)
        targets.set(key, new Set())
      }
      const target = toolTarget(label, TOOL_VERBS[label] ?? GENERIC_VERB, tc.arguments)
      targets.get(key)!.add(target ?? `\0${uniqueSeq++}`)
    }
  }

  return order
    .map((key, i) => {
      const v = key === '__generic__' ? GENERIC_VERB : TOOL_VERBS[key]
      const n = targets.get(key)!.size
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

// One replacement in an edit tool call: old text swapped for new.
export interface EditBlock {
  oldText: string
  newText: string
}

/** The edit blocks from an edit tool call's arguments (`{ edits: [...] }`), or null. */
function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string') return v
  }
  return undefined
}

/** Edit blocks from tool args ({ edits: [...] } or old_string/new_string). */
export function parseEdits(argumentsJson: string): EditBlock[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  const edits = obj.edits
  if (Array.isArray(edits)) {
    const blocks: EditBlock[] = []
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue
      const block = e as Record<string, unknown>
      const oldText = stringField(block, ['oldText', 'old_text', 'old_string', 'oldString', 'old_str', 'before'])
      const newText = stringField(block, ['newText', 'new_text', 'new_string', 'newString', 'new_str', 'after'])
      if (oldText !== undefined && newText !== undefined) {
        blocks.push({ oldText, newText })
      }
    }
    if (blocks.length > 0) return blocks
  }

  const oldText = stringField(obj, ['oldText', 'old_text', 'old_string', 'oldString', 'old_str', 'before'])
  const newText = stringField(obj, ['newText', 'new_text', 'new_string', 'newString', 'new_str', 'after'])
  if (oldText !== undefined && newText !== undefined) {
    return [{ oldText, newText }]
  }
  return null
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
 *  - enrich each toolResult with the paired call's toolName + operated-on toolFile
 *  - fold edit/write results into the call badge (drop the separate success pill)
 *  - split prose+tools so tool calls can join an adjacent tool run for grouping
 *
 * Pure; reuses message objects when nothing changed so memoized bubbles stay stable.
 */
export function prepareChatMessages(messages: DisplayMessage[]): DisplayMessage[] {
  const calls = new Map<string, { name: string; file: string | null }>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        calls.set(tc.id, { name: tc.name, file: toolCallFile(tc.name, tc.arguments) })
      }
    }
  }

  const results = new Map<string, { content: string; isError?: boolean }>()
  for (const m of messages) {
    if (m.role === 'toolResult' && m.toolCallId && !results.has(m.toolCallId)) {
      results.set(m.toolCallId, { content: m.content, isError: m.isError })
    }
  }

  const out: DisplayMessage[] = []

  // Split prose+tools so tools can join a group; pure turns stay as-is.
  const pushAssistant = (m: DisplayMessage): void => {
    const hasProse = m.content.trim().length > 0
    const hasTools = (m.toolCalls?.length ?? 0) > 0

    // Fold result bodies onto edit/write calls only. Read/bash keep a standalone
    // result pill — putting the body on the badge as well would show it twice.
    let toolCalls = m.toolCalls
    if (toolCalls && results.size > 0) {
      let changed = false
      const next = toolCalls.map((tc) => {
        const r = results.get(tc.id)
        if (!r) return tc
        const label = toolLabel(tc.name)
        const foldIntoBadge = label === 'Edit file' || label === 'Write file'
        changed = true
        return {
          ...tc,
          result: foldIntoBadge ? (tc.result ?? r.content) : tc.result,
          isError: tc.isError ?? r.isError ?? false,
        }
      })
      if (changed) toolCalls = next
    }

    const base = toolCalls !== m.toolCalls ? { ...m, toolCalls } : m
    if (!hasProse || !hasTools) {
      out.push(base)
      return
    }
    out.push({ ...base, toolCalls: undefined })
    out.push({
      ...base,
      id: `${m.id}::tools`,
      content: '',
      thinking: undefined,
      cost: undefined,
      attachments: undefined,
    })
  }

  for (const m of messages) {
    if (m.role === 'assistant') {
      pushAssistant(m)
    } else if (m.role === 'toolResult' && m.toolCallId) {
      const paired = calls.get(m.toolCallId)
      // Edit/write: result lives on the call badge. Read/bash keep a result row.
      if (paired) {
        const label = toolLabel(paired.name)
        if (label === 'Edit file' || label === 'Write file') continue
        out.push({ ...m, toolName: paired.name, toolFile: paired.file ?? undefined })
      } else {
        out.push(m)
      }
    } else {
      out.push(m)
    }
  }
  return out
}
