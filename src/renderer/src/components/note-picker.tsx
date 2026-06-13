import { useState, useMemo, useEffect, useRef } from 'react'
import { clsx } from 'clsx'
import { Search } from 'lucide-react'
import { useAppStore } from '../store'

const GLOBAL_SCOPE = 'global'

/**
 * Command-palette style overlay for quickly inserting a saved note into the
 * chat input. Opened via the input button or the Ctrl+Shift+N shortcut.
 */
export function NotePicker(): React.JSX.Element | null {
  const open = useAppStore((state) => state.notePickerOpen)
  const notes = useAppStore((state) => state.notes)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const setNotePickerOpen = useAppStore((state) => state.setNotePickerOpen)
  const insertPrompt = useAppStore((state) => state.insertPrompt)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes
      .filter((n) => n.scope === GLOBAL_SCOPE || n.scope === activeWorkspace?.id)
      .filter((n) => {
        if (!q) return true
        return (
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q) ||
          n.tags.some((t) => t.includes(q))
        )
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [notes, query, activeWorkspace?.id])

  // Reset state and focus the input whenever the picker opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      // Focus after the overlay mounts.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Keep the highlighted index within bounds as results change.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)))
  }, [results.length])

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setNotePickerOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const note = results[activeIndex]
      if (note) insertPrompt(note.body)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={() => setNotePickerOpen(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search */}
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2.5">
          <Search size={15} className="shrink-0 text-neutral-500" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Insert a note..."
            className="flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 outline-none"
          />
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-neutral-600">No matching notes</div>
          ) : (
            results.map((note, index) => (
              <button
                key={note.id}
                onClick={() => insertPrompt(note.body)}
                onMouseEnter={() => setActiveIndex(index)}
                className={clsx(
                  'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors',
                  index === activeIndex ? 'bg-neutral-800' : 'hover:bg-neutral-800/50'
                )}
              >
                <span className="truncate text-sm text-neutral-200">{note.title}</span>
                <span className="line-clamp-1 text-xs text-neutral-500">{note.body}</span>
              </button>
            ))
          )}
        </div>

        {/* Hint */}
        <div className="border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-600">
          ↑↓ navigate · Enter insert · Esc close
        </div>
      </div>
    </div>
  )
}
