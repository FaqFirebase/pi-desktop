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

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

// Verb templates for a homogeneous run (all calls map to the same label). A mixed
// or unknown run falls back to the generic "Ran N tools".
const GROUP_TITLES: Record<string, (n: number) => string> = {
  'Fetch URL': (n) => `Fetched ${plural(n, 'URL')}`,
  'Read file': (n) => `Read ${plural(n, 'file')}`,
  'Run command': (n) => `Ran ${plural(n, 'command')}`,
  'Edit file': (n) => `Edited ${plural(n, 'file')}`,
  'Write file': (n) => `Wrote ${plural(n, 'file')}`,
  Search: (n) => `${n} search${n === 1 ? '' : 'es'}`,
  'List files': (n) => `Listed ${plural(n, 'location')}`,
}

function groupTitle(run: DisplayMessage[], count: number): string {
  const labels = new Set<string>()
  for (const m of run) {
    for (const tc of m.toolCalls ?? []) labels.add(toolLabel(tc.name))
  }
  const only = labels.size === 1 ? [...labels][0] : null
  const maker = only ? GROUP_TITLES[only] : undefined
  return maker ? maker(count) : `Ran ${plural(count, 'tool')}`
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
        title: groupTitle(run, toolCallCount),
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
