import { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from './store'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'

/**
 * Subscribes to Pi events from the main process and routes them to the store.
 * Must be called once in the top-level component tree.
 */
export function usePiEvents(): void {
  const handlePiEvent = useAppStore((state) => state.handlePiEvent)

  useEffect(() => {
    // Subscribe to Pi events (status changes arrive here too, as 'status_change').
    const unsubscribeEvent = window.piDesktop.onEvent(handlePiEvent)
    return () => {
      unsubscribeEvent()
    }
  }, [handlePiEvent])
}

/**
 * Subscribes to menu actions from the application menu.
 */
export function useMenuActions(): void {
  const createNewSession = useAppStore((state) => state.createNewSession)
  const setCurrentView = useAppStore((state) => state.setCurrentView)

  useEffect(() => {
    const unsubscribe = window.piDesktop.onMenuAction((action) => {
      switch (action) {
        case 'menu:new-session':
          createNewSession()
          break
        case 'menu:new-workspace':
          setCurrentView('settings') // Open settings where workspace creation lives
          break
        case 'menu:open-project': {
          // Open dialog to select project folder
          window.piDesktop.system.openDialog({ title: 'Open Project' }).then((path) => {
            if (path) {
              const name = path.split('/').pop() ?? path
              useAppStore.getState().createWorkspace(name, path).then(() => {
                const ws = useAppStore.getState().workspaces.find((w) => w.path === path)
                if (ws) useAppStore.getState().switchWorkspace(ws.id)
              })
            }
          })
          break
        }
      }
    })

    return unsubscribe
  }, [createNewSession, setCurrentView])
}

// Distance (px) from the bottom within which we consider the user "at bottom"
// and keep following new content.
const AT_BOTTOM_THRESHOLD = 48

// A content-relative scroll position. We store this instead of a raw scrollTop
// so the reading spot survives content-height changes that happen while the chat
// is hidden — chiefly toggling Show Thinking in Settings, which shows/hides every
// thinking block. A raw scrollTop would then point at different content.
type ScrollAnchor =
  | { kind: 'bottom' }
  // Preserve distance from the bottom. Used when no prose is on screen to anchor
  // against (e.g. the viewport shows only tool boxes).
  | { kind: 'fromBottom'; distanceFromBottom: number }
  // `id` identifies a message's *text body* (the `data-scroll-anchor` marker on
  // assistant text / user messages — never on tool boxes or thinking blocks).
  // `viewportOffset` is its top edge relative to the container's top (often
  // negative — it starts above the fold). Anchoring to the prose the reader is
  // actually looking at — below any thinking block, even one in the same message
  // — means collapsing thinking above it doesn't shift it. `distanceFromBottom`
  // is a last-resort fallback if the element is somehow gone on restore.
  | { kind: 'body'; id: string; viewportOffset: number; distanceFromBottom: number }

// Snapshot the current reading position of the scroll container.
function captureAnchor(el: HTMLElement): ScrollAnchor {
  const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
  if (distanceFromBottom <= AT_BOTTOM_THRESHOLD) return { kind: 'bottom' }
  const containerTop = el.getBoundingClientRect().top
  const nodes = el.querySelectorAll<HTMLElement>('[data-scroll-anchor]')
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    // First text body whose bottom edge is below the container's top — i.e. the
    // topmost at least partially visible piece of prose.
    if (rect.bottom > containerTop) {
      return {
        kind: 'body',
        id: node.dataset.scrollAnchor as string,
        viewportOffset: rect.top - containerTop,
        distanceFromBottom,
      }
    }
  }
  return { kind: 'fromBottom', distanceFromBottom }
}

// Restore a previously captured anchor, absorbing any height change above it.
function restoreAnchor(el: HTMLElement, anchor: ScrollAnchor): void {
  if (anchor.kind === 'bottom') {
    el.scrollTop = el.scrollHeight
    return
  }
  if (anchor.kind === 'fromBottom') {
    el.scrollTop = el.scrollHeight - el.clientHeight - anchor.distanceFromBottom
    return
  }
  const node = el.querySelector<HTMLElement>(`[data-scroll-anchor="${CSS.escape(anchor.id)}"]`)
  if (!node) {
    el.scrollTop = el.scrollHeight - el.clientHeight - anchor.distanceFromBottom
    return
  }
  const containerTop = el.getBoundingClientRect().top
  const currentOffset = node.getBoundingClientRect().top - containerTop
  el.scrollTop += currentOffset - anchor.viewportOffset
}

/**
 * Manages the chat scroll container:
 *  - remembers each session's scroll offset and restores it when you switch back
 *  - follows new/streamed content (a new prompt or live tokens) while Auto Scroll
 *    is enabled; leaves the position alone when it's off
 *  - jumps to the bottom when `chatScrollBottomNonce` changes (Home resume)
 *
 * `active` is whether the chat view is currently visible; while hidden the panel
 * stays mounted (so scrollTop persists) but we defer any scrolling until it's
 * shown again, so measurements are valid.
 */
export function useChatScroll(active: boolean): {
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  atBottom: boolean
  scrollToBottom: () => void
} {
  const ref = useRef<HTMLDivElement>(null)
  const autoScroll = useAppStore(
    (state) => state.settingsDraft.autoScroll ?? state.settings?.autoScroll ?? DEFAULT_SETTINGS.autoScroll
  )
  const sessionId = useAppStore((state) => state.sessionState?.sessionId ?? null)
  const messages = useAppStore((state) => state.messages)
  const streamingContent = useAppStore((state) => state.streamingContent)
  const scrollBottomNonce = useAppStore((state) => state.chatScrollBottomNonce)

  const positions = useRef<Map<string, ScrollAnchor>>(new Map())
  const activeSession = useRef<string | null>(null)
  const seenNonce = useRef(scrollBottomNonce)
  const forceBottom = useRef(false)
  // Whether the chat was visible on the previous run, so we can re-anchor when it
  // becomes visible again (e.g. returning from Settings after toggling thinking).
  const prevActive = useRef(false)
  // While a just-switched session's messages are still loading (async), keep
  // re-applying the target scroll until content is actually present.
  const pendingRestore = useRef(false)
  // Track content size to distinguish genuinely new content from unrelated
  // re-renders (e.g. re-showing the panel), so returning to chat doesn't scroll.
  const prevMsgCount = useRef(0)
  const prevStreamLen = useRef(0)

  // Whether the viewport is at (or within a hair of) the bottom. `atBottom` (state)
  // drives the jump-to-bottom button; `atBottomRef` is read synchronously in the
  // layout effect to decide whether streamed content should keep following.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)

  // Recompute at-bottom from the live DOM and publish it to both the ref and the
  // button state (setState no-ops when unchanged, so this is cheap to call often).
  const syncAtBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = el.scrollHeight - el.clientHeight - el.scrollTop <= AT_BOTTOM_THRESHOLD
    atBottomRef.current = next
    setAtBottom(next)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }, [])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const scrollable = el.scrollHeight - el.clientHeight
    // Only remember a position while there's a real scroll range — avoids
    // clobbering the saved offset with 0 when messages are momentarily cleared
    // during a session switch.
    if (activeSession.current !== null && scrollable > AT_BOTTOM_THRESHOLD) {
      positions.current.set(activeSession.current, captureAnchor(el))
    }
    const next = scrollable - el.scrollTop <= AT_BOTTOM_THRESHOLD
    atBottomRef.current = next
    setAtBottom(next)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current

    // Did content actually grow (new message or streamed text)? Tracked even
    // while hidden so re-showing the panel isn't mistaken for new content.
    const messagesGrew = messages.length > prevMsgCount.current
    const grew = messagesGrew || streamingContent.length > prevStreamLen.current
    prevMsgCount.current = messages.length
    prevStreamLen.current = streamingContent.length

    // Defer scrolling while hidden: a display:none element has no layout, so
    // scrollHeight is 0 and any positioning would be wrong.
    if (!el || !active) {
      prevActive.current = active
      return
    }

    const becameActive = !prevActive.current
    prevActive.current = active

    if (scrollBottomNonce !== seenNonce.current) {
      seenNonce.current = scrollBottomNonce
      forceBottom.current = true
    }

    const sessionKey = sessionId ?? '__none__'
    if (activeSession.current !== sessionKey) {
      activeSession.current = sessionKey
      pendingRestore.current = true
    }

    if (pendingRestore.current) {
      const saved = positions.current.get(sessionKey)
      if (forceBottom.current || saved === undefined) {
        el.scrollTop = el.scrollHeight
      } else {
        restoreAnchor(el, saved)
      }
      // Consider the switch settled once the session's messages have loaded.
      if (messages.length > 0) {
        pendingRestore.current = false
        forceBottom.current = false
      }
      syncAtBottom()
      return
    }

    // Returned to the chat view (e.g. from Settings) in the same session. The
    // content height may have changed while hidden — Show Thinking toggles every
    // thinking block — so re-anchor to the saved reading position rather than
    // leaving the now-stale scrollTop, which would show different content.
    if (becameActive) {
      const saved = positions.current.get(sessionKey)
      if (forceBottom.current || saved === undefined) {
        el.scrollTop = el.scrollHeight
      } else {
        restoreAnchor(el, saved)
      }
      forceBottom.current = false
      // Refresh the jump-to-bottom button against the restored position: content
      // height may have changed while hidden (e.g. Show Thinking toggled), so the
      // stale at-bottom state would otherwise hide the chevron until the next scroll.
      syncAtBottom()
      return
    }

    if (forceBottom.current) {
      el.scrollTop = el.scrollHeight
      forceBottom.current = false
      syncAtBottom()
      return
    }

    // A new user message means the user just sent a prompt — always reveal it.
    const lastIsUser = messagesGrew && messages[messages.length - 1]?.role === 'user'

    // Follow new/streamed content only when Auto Scroll is on AND the user was
    // already at the bottom. If they scrolled up, leave their position put and
    // let the jump-to-bottom button take them down on demand.
    if (autoScroll && (lastIsUser || (grew && atBottomRef.current))) {
      el.scrollTop = el.scrollHeight
    }

    syncAtBottom()
  }, [active, sessionId, messages, streamingContent, scrollBottomNonce, autoScroll, syncAtBottom])

  return { scrollRef: ref, onScroll, atBottom, scrollToBottom }
}

/**
 * Keyboard shortcut handler for the chat input.
 */
export function useChatKeyboard(
  onSend: (message: string) => void,
  onAbort: () => void,
  inputRef: React.RefObject<HTMLTextAreaElement | null>
): void {
  const isStreaming = useAppStore((state) => state.isStreaming)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape: abort streaming
      if (e.key === 'Escape' && isStreaming) {
        e.preventDefault()
        onAbort()
        return
      }

      // Enter: send message (without Shift)
      if (e.key === 'Enter' && !e.shiftKey && document.activeElement === inputRef.current) {
        e.preventDefault()
        const value = inputRef.current?.value.trim()
        if (value) {
          onSend(value)
          if (inputRef.current) inputRef.current.value = ''
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isStreaming, onSend, onAbort, inputRef])
}

/**
 * Loads initial data on mount — workspaces, settings, then Pi.
 */
export function useInitialize(): void {
  const startPi = useAppStore((state) => state.startPi)
  const loadSettings = useAppStore((state) => state.loadSettings)
  const loadWorkspaces = useAppStore((state) => state.loadWorkspaces)
  const refreshSessionStats = useAppStore((state) => state.refreshSessionStats)
  const refreshSessionList = useAppStore((state) => state.refreshSessionList)

  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const initialize = async (): Promise<void> => {
      await loadSettings()
      const openToHome = useAppStore.getState().settings?.openToHomeOnLaunch ?? DEFAULT_SETTINGS.openToHomeOnLaunch

      // Pi-free data needed by both Home and Chat.
      await loadWorkspaces()
      await refreshSessionList()
      await useAppStore.getState().loadTags()
      await useAppStore.getState().loadArchivedSessions()
      await useAppStore.getState().loadNotes()
      // Model id -> display-name map for chat/history; reads ~/.pi/agent/models.json.
      void useAppStore.getState().loadCustomModels()
      // Best-effort GitHub release check (non-blocking).
      void useAppStore.getState().checkForUpdates()

      if (openToHome) {
        // Land on the Home/launcher screen; Pi starts lazily on first action.
        useAppStore.getState().setCurrentView('home')
        return
      }

      // Legacy: boot into Chat and resume the last session. reloadActiveSession
      // pulls the resumed session's message history (refreshSessionState alone
      // only loads metadata, leaving the chat empty).
      useAppStore.getState().setCurrentView('chat')
      await startPi()
      await useAppStore.getState().reloadActiveSession()
      await refreshSessionStats()
    }

    initialize()
  }, [startPi, loadSettings, loadWorkspaces, refreshSessionStats, refreshSessionList])
}

/**
 * Global shortcut (Ctrl+Shift+P) that toggles the quick note picker, letting
 * the user insert a saved prompt from anywhere in the app. (Ctrl+Shift+N is
 * reserved for the New Workspace menu accelerator.)
 */
export function useNotePickerShortcut(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        const { notePickerOpen, setNotePickerOpen } = useAppStore.getState()
        setNotePickerOpen(!notePickerOpen)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
