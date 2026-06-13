import { useEffect, useState, useCallback, useRef } from 'react'
import { clsx } from 'clsx'
import {
  Copy,
  Scissors,
  ClipboardPaste,
  TextSelect,
  ExternalLink,
  Search,
  Archive,
  ArchiveRestore,
  Trash2,
  MessageSquare,
  NotebookPen,
} from 'lucide-react'
import type { SessionListItem } from '../../../shared/ipc-contracts'

interface ContextMenuItem {
  id: string
  label: string
  icon?: React.ReactNode
  shortcut?: string
  disabled?: boolean
  divider?: boolean
  action: () => void
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}

const MENU_WIDTH = 220
const MENU_ITEM_HEIGHT = 32
const PADDING = 8

export function useContextMenu(): {
  show: (e: React.MouseEvent, items: ContextMenuItem[]) => void
  hide: () => void
  ContextMenuComponent: React.JSX.Element | null
} {
  const [state, setState] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    items: [],
  })

  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  const show = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()

    // Remember the element to restore focus to when the menu closes.
    triggerRef.current = document.activeElement as HTMLElement | null

    // Calculate position, keeping menu within viewport
    let x = e.clientX
    let y = e.clientY
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    if (x + MENU_WIDTH > viewportWidth - PADDING) {
      x = viewportWidth - MENU_WIDTH - PADDING
    }

    const estimatedHeight = items.filter((i) => !i.divider).length * MENU_ITEM_HEIGHT + 20
    if (y + estimatedHeight > viewportHeight - PADDING) {
      y = viewportHeight - estimatedHeight - PADDING
    }

    setState({ visible: true, x, y, items })
  }, [])

  const hide = useCallback(() => {
    setState((prev) => ({ ...prev, visible: false }))
  }, [])

  // Close on click outside
  useEffect(() => {
    if (!state.visible) return

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hide()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      // Escape closes; Tab dismisses so focus isn't trapped behind the menu.
      if (e.key === 'Escape' || e.key === 'Tab') hide()
    }

    // Delay to avoid immediate close from the same right-click
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick)
      document.addEventListener('keydown', handleEscape)
    }, 10)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [state.visible, hide])

  // Close on scroll
  useEffect(() => {
    if (!state.visible) return
    const handleScroll = () => hide()
    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [state.visible, hide])

  // Move focus into the menu when it opens; restore it to the trigger on close.
  useEffect(() => {
    if (state.visible) {
      menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    } else if (triggerRef.current) {
      triggerRef.current.focus()
      triggerRef.current = null
    }
  }, [state.visible])

  const component = state.visible ? (
    <div
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      className="fixed z-[9999] min-w-[180px] rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/40 animate-fade-in"
      style={{ left: state.x, top: state.y }}
    >
      {state.items.map((item) => {
        if (item.divider) {
          return <div key={item.id} className="my-1 border-t border-neutral-800" />
        }

        return (
          <button
            key={item.id}
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation()
              if (!item.disabled) {
                item.action()
                hide()
              }
            }}
            disabled={item.disabled}
            className={clsx(
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-sm transition-colors',
              item.disabled
                ? 'text-neutral-600 cursor-not-allowed'
                : 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100'
            )}
          >
            {item.icon && (
              <span className="w-4 h-4 flex items-center justify-center text-neutral-500">
                {item.icon}
              </span>
            )}
            <span className="flex-1 text-left">{item.label}</span>
            {item.shortcut && (
              <span className="text-xs text-neutral-600 ml-4">{item.shortcut}</span>
            )}
          </button>
        )
      })}
    </div>
  ) : null

  return { show, hide, ContextMenuComponent: component }
}

// ─── Built-in Context Menu Items ─────────────────────────────────────────────

function getSelectedText(): string {
  const selection = window.getSelection()
  return selection?.toString() ?? ''
}

export function buildDefaultContextMenu(): ContextMenuItem[] {
  const selectedText = getSelectedText()
  const hasSelection = selectedText.length > 0

  return [
    {
      id: 'copy',
      label: 'Copy',
      icon: <Copy size={14} />,
      shortcut: 'Ctrl+C',
      disabled: !hasSelection,
      action: () => {
        if (hasSelection) {
          navigator.clipboard.writeText(selectedText)
        }
      },
    },
    {
      id: 'cut',
      label: 'Cut',
      icon: <Scissors size={14} />,
      shortcut: 'Ctrl+X',
      disabled: !hasSelection,
      action: () => {
        if (hasSelection) {
          navigator.clipboard.writeText(selectedText)
          // Try to delete the selection (works in input/textarea)
          document.execCommand('delete')
        }
      },
    },
    {
      id: 'paste',
      label: 'Paste',
      icon: <ClipboardPaste size={14} />,
      shortcut: 'Ctrl+V',
      action: async () => {
        try {
          const text = await navigator.clipboard.readText()
          // Try to paste into focused element
          const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
          if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            const start = active.selectionStart ?? 0
            const end = active.selectionEnd ?? 0
            const before = active.value.slice(0, start)
            const after = active.value.slice(end)
            active.value = before + text + after
            active.selectionStart = active.selectionEnd = start + text.length
            active.dispatchEvent(new Event('input', { bubbles: true }))
          } else {
            document.execCommand('insertText', false, text)
          }
        } catch {
          // Clipboard API may be blocked
        }
      },
    },
    {
      id: 'divider-1',
      label: '',
      divider: true,
      action: () => {},
    },
    {
      id: 'select-all',
      label: 'Select All',
      icon: <TextSelect size={14} />,
      shortcut: 'Ctrl+A',
      action: () => {
        document.execCommand('selectAll')
      },
    },
    {
      id: 'copy-all',
      label: 'Copy All Visible Text',
      icon: <Copy size={14} />,
      disabled: !hasSelection,
      action: () => {
        if (hasSelection) {
          navigator.clipboard.writeText(selectedText)
        }
      },
    },
  ]
}

export function buildCodeBlockContextMenu(code: string): ContextMenuItem[] {
  return [
    {
      id: 'copy-code',
      label: 'Copy Code Block',
      icon: <Copy size={14} />,
      shortcut: 'Ctrl+Shift+C',
      action: () => navigator.clipboard.writeText(code),
    },
    {
      id: 'search-code',
      label: 'Search Selection',
      icon: <Search size={14} />,
      disabled: !getSelectedText(),
      action: () => {
        const text = getSelectedText()
        if (text) {
          window.piDesktop.system.openExternal(
            `https://www.google.com/search?q=${encodeURIComponent(text)}`
          )
        }
      },
    },
    ...buildDefaultContextMenu(),
  ]
}

export function buildMessageContextMenu(
  messageContent: string,
  onAddToNotes: (text: string) => void
): ContextMenuItem[] {
  const selectedText = getSelectedText()
  const hasSelection = selectedText.length > 0

  return [
    {
      id: 'copy-message',
      label: 'Copy Message',
      icon: <Copy size={14} />,
      action: () => navigator.clipboard.writeText(messageContent),
    },
    {
      id: 'copy-selection',
      label: 'Copy Selection',
      icon: <Copy size={14} />,
      disabled: !hasSelection,
      action: () => {
        if (hasSelection) navigator.clipboard.writeText(selectedText)
      },
    },
    {
      id: 'add-to-notes',
      label: hasSelection ? 'Add Selection to Notes' : 'Add Message to Notes',
      icon: <NotebookPen size={14} />,
      action: () => onAddToNotes(hasSelection ? selectedText : messageContent),
    },
    {
      id: 'divider-1',
      label: '',
      divider: true,
      action: () => {},
    },
    ...buildDefaultContextMenu(),
  ]
}

/**
 * Right-click menu for session entries (sidebar Recent Sessions list,
 * Sessions panel rows). Centralizes the Open / Archive / Delete actions
 * so both surfaces show the same behavior.
 */
export interface SessionContextMenuActions {
  onOpen: (session: SessionListItem) => void
  onArchive: (sessionId: string) => void
  onUnarchive: (sessionId: string) => void
  onDelete: (session: SessionListItem) => void
}

export function buildSessionContextMenu(
  session: SessionListItem,
  isArchived: boolean,
  actions: SessionContextMenuActions
): ContextMenuItem[] {
  const displayName = session.name || session.sessionId.slice(0, 12)
  return [
    {
      id: 'session-open',
      label: 'Open Session',
      icon: <MessageSquare size={14} />,
      action: () => actions.onOpen(session),
    },
    {
      id: 'divider-session-1',
      label: '',
      divider: true,
      action: () => {},
    },
    isArchived
      ? {
          id: 'session-unarchive',
          label: 'Unarchive',
          icon: <ArchiveRestore size={14} />,
          action: () => actions.onUnarchive(session.sessionId),
        }
      : {
          id: 'session-archive',
          label: 'Archive',
          icon: <Archive size={14} />,
          action: () => actions.onArchive(session.sessionId),
        },
    {
      id: 'session-delete',
      label: 'Delete…',
      icon: <Trash2 size={14} />,
      action: () => {
        // Confirm before destructive action. Trash is recoverable when
        // installed; without it, delete is permanent. The wording is
        // honest about that.
        const ok = window.confirm(
          `Delete session "${displayName}"?\n\nWill use the system 'trash' CLI if installed (recoverable); otherwise the .jsonl session file is permanently removed.`
        )
        if (ok) actions.onDelete(session)
      },
    },
  ]
}

export function buildLinkContextMenu(url: string): ContextMenuItem[] {
  return [
    {
      id: 'open-link',
      label: 'Open Link',
      icon: <ExternalLink size={14} />,
      action: () => window.piDesktop.system.openExternal(url),
    },
    {
      id: 'copy-link',
      label: 'Copy Link',
      icon: <Copy size={14} />,
      action: () => navigator.clipboard.writeText(url),
    },
    {
      id: 'divider-1',
      label: '',
      divider: true,
      action: () => {},
    },
    ...buildDefaultContextMenu(),
  ]
}
