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
