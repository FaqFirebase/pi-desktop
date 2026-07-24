import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

// Named CSS custom highlights, styled via the ::highlight() rules injected by
// ensureHighlightStyles() below.
const HIGHLIGHT_ALL = 'pi-search'
const HIGHLIGHT_CURRENT = 'pi-search-current'

// These rules are injected at runtime via a plain <style> element rather than
// living in index.css: Tailwind's Lightning CSS transformer doesn't recognize
// the ::highlight() pseudo-element and — depending on lightningcss version —
// drops the rule at build time (it warns, and newer versions strip it), which
// would leave search matches with no visible highlight in the built app.
// Injecting the <style> bypasses that pipeline entirely.
const HIGHLIGHT_STYLE_ID = 'pi-search-highlight-styles'
const HIGHLIGHT_CSS = `
::highlight(${HIGHLIGHT_ALL}) {
  background-color: rgba(250, 204, 21, 0.28);
}
::highlight(${HIGHLIGHT_CURRENT}) {
  background-color: rgba(250, 204, 21, 0.85);
  color: #1a1a1a;
}
`

// Idempotently add the highlight rules to <head> (keyed by id).
function ensureHighlightStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = HIGHLIGHT_STYLE_ID
  style.textContent = HIGHLIGHT_CSS
  document.head.appendChild(style)
}

// Feature-detect the CSS Custom Highlight API (Chromium 105+, always present in
// our Electron; guarded so a missing API degrades to "no highlight" rather than
// throwing).
function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

/**
 * In-conversation find bar. Highlights every case-insensitive match of the query
 * across the chat transcript using the CSS Custom Highlight API (no DOM mutation,
 * so it works over rendered markdown) and lets the user step through matches.
 *
 * `containerRef` is the scrollable messages element to search within.
 */
export function ChatSearch({
  containerRef,
  focusNonce,
  onClose,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  focusNonce: number
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(0) // 0-based; displayed as current + 1

  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  const currentRef = useRef(0)
  const prevQuery = useRef('')

  // Recompute when the transcript changes while the bar is open.
  const messages = useAppStore((state) => state.messages)

  const clearHighlights = useCallback(() => {
    if (!highlightsSupported()) return
    CSS.highlights.delete(HIGHLIGHT_ALL)
    CSS.highlights.delete(HIGHLIGHT_CURRENT)
  }, [])

  // Build ranges for all matches within the container's text nodes. Matches are
  // confined to a single text node (won't span inline element boundaries) — fine
  // for reading-position search.
  const computeRanges = useCallback(
    (q: string): Range[] => {
      const root = containerRef.current
      if (!root || !q) return []
      const needle = q.toLowerCase()
      const ranges: Range[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.nodeValue && node.nodeValue.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      })
      let node = walker.nextNode()
      while (node) {
        const hay = (node.nodeValue ?? '').toLowerCase()
        let idx = hay.indexOf(needle)
        while (idx !== -1) {
          const range = document.createRange()
          range.setStart(node, idx)
          range.setEnd(node, idx + needle.length)
          ranges.push(range)
          idx = hay.indexOf(needle, idx + needle.length)
        }
        node = walker.nextNode()
      }
      return ranges
    },
    [containerRef]
  )

  const applyHighlights = useCallback(
    (ranges: Range[], index: number) => {
      if (!highlightsSupported()) return
      if (ranges.length === 0) {
        clearHighlights()
        return
      }
      CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges))
      const cur = ranges[index]
      if (cur) CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(cur))
      else CSS.highlights.delete(HIGHLIGHT_CURRENT)
    },
    [clearHighlights]
  )

  const scrollIntoView = useCallback(
    (ranges: Range[], index: number) => {
      const root = containerRef.current
      const range = ranges[index]
      if (!root || !range) return
      const r = range.getBoundingClientRect()
      const c = root.getBoundingClientRect()
      // Only scroll if the match is outside the visible band; then center it.
      if (r.top < c.top || r.bottom > c.bottom) {
        root.scrollTop += r.top - c.top - root.clientHeight / 2 + r.height / 2
      }
    },
    [containerRef]
  )

  // Recompute matches when the query or the transcript changes. Scroll to the
  // first match only when the query itself changed — a transcript update (e.g. a
  // new streamed message) refreshes highlights without yanking the view.
  useEffect(() => {
    const queryChanged = prevQuery.current !== query
    prevQuery.current = query

    const ranges = computeRanges(query)
    rangesRef.current = ranges
    const idx =
      ranges.length === 0 ? 0 : queryChanged ? 0 : Math.min(currentRef.current, ranges.length - 1)
    currentRef.current = idx
    setCount(ranges.length)
    setCurrent(idx)
    applyHighlights(ranges, idx)
    if (queryChanged && ranges.length > 0) scrollIntoView(ranges, idx)
  }, [query, messages, computeRanges, applyHighlights, scrollIntoView])

  // Inject the ::highlight() rules once (see note by HIGHLIGHT_CSS).
  useEffect(() => {
    ensureHighlightStyles()
  }, [])

  // Focus (and select) on open and whenever Ctrl+F is pressed again.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce])

  // Drop highlights when the bar unmounts.
  useEffect(() => clearHighlights, [clearHighlights])

  const go = useCallback(
    (delta: number) => {
      const ranges = rangesRef.current
      if (ranges.length === 0) return
      const next = (currentRef.current + delta + ranges.length) % ranges.length
      currentRef.current = next
      setCurrent(next)
      applyHighlights(ranges, next)
      scrollIntoView(ranges, next)
    },
    [applyHighlights, scrollIntoView]
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    }
  }

  return (
    <div className="absolute right-4 top-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-2 shadow-lg shadow-black/30">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in page"
        className="w-48 bg-transparent px-1 py-0.5 text-base text-primary outline-none placeholder:text-faint"
      />
      <span className="min-w-[3rem] shrink-0 text-center text-xs tabular-nums text-dim">
        {query === '' ? '' : `${count === 0 ? 0 : current + 1}/${count}`}
      </span>
      <SearchIconButton
        icon={<ChevronUp size={14} />}
        onClick={() => go(-1)}
        title="Previous match (Shift+Enter)"
        disabled={count === 0}
      />
      <SearchIconButton
        icon={<ChevronDown size={14} />}
        onClick={() => go(1)}
        title="Next match (Enter)"
        disabled={count === 0}
      />
      <SearchIconButton icon={<X size={14} />} onClick={onClose} title="Close (Esc)" />
    </div>
  )
}

function SearchIconButton({
  icon,
  onClick,
  title,
  disabled,
}: {
  icon: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {icon}
    </button>
  )
}
