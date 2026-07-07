import { useEffect, useRef } from 'react'
import { useAppStore } from './store'

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

/**
 * Auto-scrolls an element to the bottom when content changes.
 */
export function useAutoScroll<T>(dependency: T): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const autoScroll = useAppStore((state) => state.settings?.autoScroll ?? true)

  useEffect(() => {
    if (autoScroll && ref.current) {
      ref.current.scrollTo({
        top: ref.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [dependency, autoScroll])

  return ref
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
  const refreshSessionState = useAppStore((state) => state.refreshSessionState)
  const refreshSessionStats = useAppStore((state) => state.refreshSessionStats)
  const refreshSessionList = useAppStore((state) => state.refreshSessionList)

  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const initialize = async (): Promise<void> => {
      await loadSettings()
      const openToHome = useAppStore.getState().settings?.openToHomeOnLaunch ?? true

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

      // Legacy: boot into Chat and resume the last session.
      useAppStore.getState().setCurrentView('chat')
      await startPi()
      await refreshSessionState()
      await refreshSessionStats()
      await refreshSessionList()
    }

    initialize()
  }, [startPi, loadSettings, loadWorkspaces, refreshSessionState, refreshSessionStats, refreshSessionList])
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
