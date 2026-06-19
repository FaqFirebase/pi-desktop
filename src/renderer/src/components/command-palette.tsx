import { useState, useMemo, useEffect, useRef } from 'react'
import { clsx } from 'clsx'
import { Terminal } from 'lucide-react'
import { useAppStore } from '../store'
import { filterCommands } from '../../../shared/pi-command'

const SOURCE_BADGE: Record<string, string> = {
  skill: 'bg-purple-900/40 text-purple-300',
  prompt: 'bg-blue-900/40 text-blue-300',
  extension: 'bg-emerald-900/40 text-emerald-300',
}

/** Token inserted into the composer when a command is chosen. */
function invocationToken(name: string, source: string): string {
  if (source === 'skill') return `/skill:${name.replace(/^skill:/, '')} `
  return `/${name} `
}

export function CommandPalette(): React.JSX.Element | null {
  const open = useAppStore((s) => s.commandPaletteOpen)
  const initialQuery = useAppStore((s) => s.commandPaletteQuery)
  const commands = useAppStore((s) => s.commands)
  const setCommandPalette = useAppStore((s) => s.setCommandPalette)
  const insertPrompt = useAppStore((s) => s.insertPrompt)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => filterCommands(commands, query), [commands, query])

  useEffect(() => {
    if (open) {
      setQuery(initialQuery)
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open, initialQuery])

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)))
  }, [results.length])

  if (!open) return null

  const choose = (index: number): void => {
    const cmd = results[index]
    if (cmd) insertPrompt(invocationToken(cmd.name, cmd.source), true)
    setCommandPalette(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setCommandPalette(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      choose(activeIndex)
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
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-neutral-600">
              {commands.length === 0
                ? 'No commands available — is PI running?'
                : 'No matching commands'}
            </div>
          ) : (
            results.map((cmd, index) => (
              <button
                key={`${cmd.source}:${cmd.name}`}
                onClick={() => choose(index)}
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
                <span className="truncate text-sm text-neutral-200">{cmd.name}</span>
                <span className="ml-auto line-clamp-1 text-xs text-neutral-500">
                  {cmd.description}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-600">
          ↑↓ navigate · Enter/Tab insert · Esc close
        </div>
      </div>
    </div>
  )
}
