import { useState, useMemo, useEffect, useRef } from 'react'
import { clsx } from 'clsx'
import { Terminal } from 'lucide-react'
import { useAppStore } from '../store'
import { filterCommands, type PiCommand } from '../../../shared/pi-command'

// Source used for Pi built-in commands that map to a GUI action rather than
// being inserted as text. Pi's RPC only expands `/skill:` and `/template` from
// typed input, so these built-ins run the equivalent GUI action directly.
const BUILTIN_SOURCE = 'builtin'

const SOURCE_BADGE: Record<string, string> = {
  skill: 'bg-purple-900/40 text-purple-300',
  prompt: 'bg-blue-900/40 text-blue-300',
  [BUILTIN_SOURCE]: 'bg-amber-900/40 text-amber-300',
  extension: 'bg-emerald-900/40 text-emerald-300',
}

const GROUPS: Array<{ source: string; label: string }> = [
  { source: 'skill', label: 'Skills' },
  { source: 'prompt', label: 'Prompts' },
  { source: BUILTIN_SOURCE, label: 'Commands' },
  { source: 'extension', label: 'Extensions' },
]

/** Token inserted into the composer when a skill/prompt/extension is chosen. */
function invocationToken(name: string, source: string): string {
  if (source === 'skill') return `/skill:${name.replace(/^skill:/, '')} `
  return `/${name} `
}

interface BuiltinCommand {
  name: string
  description: string
  run: () => void
}

export function CommandPalette(): React.JSX.Element | null {
  const open = useAppStore((s) => s.commandPaletteOpen)
  const initialQuery = useAppStore((s) => s.commandPaletteQuery)
  const replace = useAppStore((s) => s.commandPaletteReplace)
  const commands = useAppStore((s) => s.commands)
  const setCommandPalette = useAppStore((s) => s.setCommandPalette)
  const insertPrompt = useAppStore((s) => s.insertPrompt)
  const compactContext = useAppStore((s) => s.compactContext)
  const cloneBranch = useAppStore((s) => s.cloneBranch)
  const createNewSession = useAppStore((s) => s.createNewSession)
  const setCurrentView = useAppStore((s) => s.setCurrentView)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Pi built-in commands that have a direct GUI equivalent. Excludes built-ins
  // that need an argument or aren't supported in the GUI (e.g. /name, /tree).
  const builtins = useMemo<BuiltinCommand[]>(
    () => [
      { name: 'compact', description: 'Compact the conversation to free up context', run: () => { void compactContext() } },
      { name: 'clone', description: 'Clone the current branch into a new session', run: () => { void cloneBranch() } },
      { name: 'new', description: 'Start a new session', run: () => { void createNewSession() } },
      { name: 'resume', description: 'Open the Sessions list', run: () => setCurrentView('sessions') },
      { name: 'fork', description: 'Open Branches to fork from a message', run: () => setCurrentView('timeline') },
      { name: 'settings', description: 'Open Settings', run: () => setCurrentView('settings') },
    ],
    [compactContext, cloneBranch, createNewSession, setCurrentView]
  )

  const allCommands = useMemo<PiCommand[]>(
    () => [
      ...commands,
      ...builtins.map((b) => ({ name: b.name, description: b.description, source: BUILTIN_SOURCE })),
    ],
    [commands, builtins]
  )

  const results = useMemo(() => filterCommands(allCommands, query), [allCommands, query])

  // Ordered groups plus an "Other" catch-all for any unexpected source, so
  // nothing is silently hidden.
  const grouped = useMemo(() => {
    const known = new Set(GROUPS.map((g) => g.source))
    const out = GROUPS.map((g) => ({
      label: g.label,
      items: results.filter((r) => r.source === g.source),
    })).filter((g) => g.items.length > 0)
    const other = results.filter((r) => !known.has(r.source))
    if (other.length > 0) out.push({ label: 'Other', items: other })
    return out
  }, [results])

  // Flattened order matches visual order — keyboard nav indexes this list.
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped])

  useEffect(() => {
    if (open) {
      setQuery(initialQuery)
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open, initialQuery])

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, flat.length - 1)))
  }, [flat.length])

  if (!open) return null

  const choose = (cmd: PiCommand | undefined): void => {
    if (cmd) {
      if (cmd.source === BUILTIN_SOURCE) {
        builtins.find((b) => b.name === cmd.name)?.run()
      } else {
        insertPrompt(invocationToken(cmd.name, cmd.source), replace)
      }
    }
    setCommandPalette(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setCommandPalette(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      choose(flat[activeIndex])
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={() => setCommandPalette(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2.5">
          <Terminal size={15} className="shrink-0 text-neutral-500" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Run a skill, prompt, or command..."
            className="flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 outline-none"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-neutral-600">No matching commands</div>
          ) : (
            grouped.map((group) => (
              <div key={group.label}>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
                  {group.label}
                </div>
                {group.items.map((cmd) => {
                  const index = flat.indexOf(cmd)
                  return (
                    <button
                      key={`${cmd.source}:${cmd.name}`}
                      onClick={() => choose(cmd)}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={clsx(
                        'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                        index === activeIndex ? 'bg-neutral-800' : 'hover:bg-neutral-800/50'
                      )}
                    >
                      <span
                        className={clsx(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase',
                          SOURCE_BADGE[cmd.source] ?? 'bg-neutral-800 text-neutral-400'
                        )}
                      >
                        {cmd.source}
                      </span>
                      <span className="truncate text-sm text-neutral-200">
                        {cmd.source === BUILTIN_SOURCE ? `/${cmd.name}` : cmd.name}
                      </span>
                      <span className="ml-auto line-clamp-1 text-xs text-neutral-500">
                        {cmd.description}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-600">
          ↑↓ navigate · Enter/Tab run · Esc close
        </div>
      </div>
    </div>
  )
}
