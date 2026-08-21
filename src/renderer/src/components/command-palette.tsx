import { useState, useMemo, useEffect, useRef } from 'react'
import { Check, File, Layers, MessageSquare, Search } from 'lucide-react'
import { clsx } from 'clsx'
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
import {
  filterSessions,
  filterWorkspaces,
  MAX_FILE_RESULTS,
  type SwitcherItem,
} from '../utils/quick-switcher'
import { rankFileResults } from '../utils/rank-file-results'
import { createStaleGuard } from '../utils/stale-guard'
import { getSessionTitle } from '../utils/session-title'
import { isImagePath } from './chat-file-link'
import type { FileSearchResult } from '../../../shared/ipc-contracts'

const FILE_SEARCH_DEBOUNCE_MS = 150

/** A palette row: a command, or a workspace / session / file switcher hit. */
type PaletteEntry = PiCommand | SwitcherItem

/**
 * Quick switcher opened with Ctrl/Cmd+K: commands plus workspaces, sessions,
 * and files in one searchable list. Chosen commands insert their token at the
 * composer caret (builtins run their GUI action instead), so an existing
 * draft is never overwritten. A leading `/` narrows to commands only, the
 * inline slash popup's territory. Switcher picks go through the store's
 * guarded actions (streaming/dirty-editor confirms), so a decline is safe.
 */
export function CommandPalette(): React.JSX.Element | null {
  const open = useAppStore((s) => s.commandPaletteOpen)
  const setCommandPalette = useAppStore((s) => s.setCommandPalette)
  const insertPrompt = useAppStore((s) => s.insertPrompt)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspace = useAppStore((s) => s.activeWorkspace)
  const sessionList = useAppStore((s) => s.sessionList)
  const { builtins, allCommands } = useCommandCatalog()

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const searchGuard = useMemo(() => createStaleGuard(), [])

  // A leading slash keeps the old commands-only behavior.
  const commandsOnly = query.trimStart().startsWith('/')
  const switcherQuery = commandsOnly ? '' : query.trim()

  const commandResults = useMemo(() => filterCommands(allCommands, query), [allCommands, query])
  const { grouped, flat: commandFlat } = useMemo(() => groupCommands(commandResults), [commandResults])

  const workspaceItems = useMemo<SwitcherItem[]>(
    () =>
      commandsOnly
        ? []
        : filterWorkspaces(workspaces, switcherQuery).map((workspace) => ({ kind: 'workspace', workspace })),
    [commandsOnly, workspaces, switcherQuery]
  )
  // Sessions and files only make sense against a typed query.
  const sessionItems = useMemo<SwitcherItem[]>(
    () =>
      switcherQuery === ''
        ? []
        : filterSessions(sessionList, switcherQuery).map((session) => ({ kind: 'session', session })),
    [sessionList, switcherQuery]
  )
  const fileItems = useMemo<SwitcherItem[]>(
    () => fileResults.map((result) => ({ kind: 'file', result })),
    [fileResults]
  )

  const entries = useMemo<PaletteEntry[]>(
    () => [...commandFlat, ...workspaceItems, ...sessionItems, ...fileItems],
    [commandFlat, workspaceItems, sessionItems, fileItems]
  )

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setFileResults([])
      // Sessions may be stale if nothing refreshed the list recently.
      void useAppStore.getState().refreshSessionList()
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, entries.length - 1)))
  }, [entries.length])

  // Debounced workspace file search; the guard drops out-of-order responses.
  useEffect(() => {
    if (!open || switcherQuery === '') {
      // Also invalidates any in-flight search — without this, clearing the
      // query (or typing '/') would let a slow response repopulate the list.
      searchGuard.begin()
      setFileResults([])
      return
    }
    const isCurrent = searchGuard.begin()
    const timer = window.setTimeout(async () => {
      try {
        const results = await window.piDesktop.files.search(switcherQuery)
        if (isCurrent()) setFileResults(rankFileResults(results, switcherQuery).slice(0, MAX_FILE_RESULTS))
      } catch {
        // No workspace or search failure — the Files section just stays empty.
        if (isCurrent()) setFileResults([])
      }
    }, FILE_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, switcherQuery, searchGuard])

  if (!open) return null

  const close = (): void => setCommandPalette(false)

  const openFile = async (result: FileSearchResult): Promise<void> => {
    const ok = await useAppStore.getState().setPreviewTarget({
      kind: isImagePath(result.name) ? 'image' : 'code',
      name: result.name,
      path: result.path,
      relativePath: result.relativePath,
    })
    // The preview pane lives in the chat view.
    if (ok && useAppStore.getState().currentView !== 'chat') {
      useAppStore.getState().setCurrentView('chat')
    }
  }

  // Run the chosen entry; choosing nothing (Enter on an empty result list)
  // just closes — the composer draft is never touched.
  const choose = (entry: PaletteEntry | undefined): void => {
    if (entry) {
      if ('kind' in entry) {
        if (entry.kind === 'workspace') {
          if (entry.workspace.id !== activeWorkspace?.id) {
            void useAppStore.getState().activateWorkspace(entry.workspace.id)
          }
        } else if (entry.kind === 'session') {
          void useAppStore.getState().openSessionItem(entry.session)
        } else {
          void openFile(entry.result)
        }
      } else if (entry.source === BUILTIN_SOURCE) {
        builtins.find((b) => b.name === entry.name)?.run()
      } else {
        insertPrompt(invocationToken(entry.name, entry.source))
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
      setActiveIndex((i) => Math.min(i + 1, entries.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      choose(entries[activeIndex])
    }
  }

  const sections: Array<{ label: string; items: SwitcherItem[]; startIndex: number }> = []
  let offset = commandFlat.length
  for (const [label, items] of [
    ['Workspaces', workspaceItems],
    ['Sessions', sessionItems],
    ['Files', fileItems],
  ] as const) {
    if (items.length > 0) sections.push({ label, items, startIndex: offset })
    offset += items.length
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
          <Search size={15} className="shrink-0 text-dim" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search commands, workspaces, sessions, files..."
            className="flex-1 bg-transparent text-sm text-primary placeholder:text-faint outline-none"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {entries.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-faint">No matches</div>
          ) : (
            <>
              {commandFlat.length > 0 && (
                <CommandResults
                  grouped={grouped}
                  flat={commandFlat}
                  activeIndex={activeIndex}
                  onSelect={choose}
                  onHover={setActiveIndex}
                />
              )}
              {sections.map((section) => (
                <div key={section.label}>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-faint">
                    {section.label}
                  </div>
                  {section.items.map((item, itemIndex) => {
                    const index = section.startIndex + itemIndex
                    return (
                      <SwitcherRow
                        key={switcherKey(item)}
                        item={item}
                        active={index === activeIndex}
                        activeWorkspaceId={activeWorkspace?.id ?? null}
                        onSelect={() => choose(item)}
                        onHover={() => setActiveIndex(index)}
                      />
                    )
                  })}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-faint">
          ↑↓ navigate · Enter/Tab run · / commands only · Esc close
        </div>
      </div>
    </div>
  )
}

function switcherKey(item: SwitcherItem): string {
  if (item.kind === 'workspace') return `ws:${item.workspace.id}`
  if (item.kind === 'session') return `session:${item.session.path}`
  return `file:${item.result.path}`
}

function SwitcherRow({
  item,
  active,
  activeWorkspaceId,
  onSelect,
  onHover,
}: {
  item: SwitcherItem
  active: boolean
  activeWorkspaceId: string | null
  onSelect: () => void
  onHover: () => void
}): React.JSX.Element {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
        active ? 'bg-card' : 'hover:bg-surface-hover/50'
      )}
    >
      {item.kind === 'workspace' && (
        <>
          <Layers size={14} className="shrink-0" style={{ color: item.workspace.color }} />
          <span className="truncate text-sm text-primary">{item.workspace.name}</span>
          {item.workspace.id === activeWorkspaceId && (
            <Check size={12} className="shrink-0 text-success" />
          )}
          <span className="ml-auto line-clamp-1 text-xs text-dim">{item.workspace.path}</span>
        </>
      )}
      {item.kind === 'session' && (
        <>
          <MessageSquare size={14} className="shrink-0 text-dim" />
          <span className="truncate text-sm text-primary">
            {getSessionTitle(item.session.name, item.session.sessionId, item.session.preview)}
          </span>
          <span className="ml-auto line-clamp-1 text-xs text-dim">{item.session.projectName}</span>
        </>
      )}
      {item.kind === 'file' && (
        <>
          <File size={14} className="shrink-0 text-dim" />
          <span className="truncate text-sm text-primary">{item.result.name}</span>
          <span className="ml-auto line-clamp-1 text-xs text-dim">{item.result.relativePath}</span>
        </>
      )}
    </button>
  )
}
