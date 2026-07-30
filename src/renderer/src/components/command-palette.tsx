import { useState, useMemo, useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'
import { useAppStore } from '../store'
import { useCommandCatalog } from '../hooks'
import { CommandResults } from './command-results'
import {
  BUILTIN_SOURCE,
  filterCommands,
  groupCommands,
  invocationToken,
  type PiCommand,
} from '../../../shared/pi-command'

/**
 * Modal launcher opened with Ctrl/Cmd+K. Chosen commands insert their token at
 * the composer caret (builtins run their GUI action instead), so an existing
 * draft is never overwritten. Slash-typing in the composer is handled by
 * ChatInput's inline popup, which never takes focus from the textarea.
 */
export function CommandPalette(): React.JSX.Element | null {
  const open = useAppStore((s) => s.commandPaletteOpen)
  const setCommandPalette = useAppStore((s) => s.setCommandPalette)
  const insertPrompt = useAppStore((s) => s.insertPrompt)
  const { builtins, allCommands } = useCommandCatalog()

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => filterCommands(allCommands, query), [allCommands, query])
  const { grouped, flat } = useMemo(() => groupCommands(results), [results])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, flat.length - 1)))
  }, [flat.length])

  if (!open) return null

  const close = (): void => setCommandPalette(false)

  // Run the chosen command; choosing nothing (Enter on an empty result list)
  // just closes — the composer draft is never touched.
  const choose = (cmd: PiCommand | undefined): void => {
    if (cmd) {
      if (cmd.source === BUILTIN_SOURCE) {
        builtins.find((b) => b.name === cmd.name)?.run()
      } else {
        insertPrompt(invocationToken(cmd.name, cmd.source))
      }
    }
    close()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
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
      onClick={close}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Terminal size={15} className="shrink-0 text-dim" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Run a skill, prompt, or command..."
            className="flex-1 bg-transparent text-sm text-primary placeholder:text-faint outline-none"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-faint">No matching commands</div>
          ) : (
            <CommandResults
              grouped={grouped}
              flat={flat}
              activeIndex={activeIndex}
              onSelect={choose}
              onHover={setActiveIndex}
            />
          )}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-faint">
          ↑↓ navigate · Enter/Tab run · Esc close
        </div>
      </div>
    </div>
  )
}
