import { useEffect, useRef } from 'react'
import { useAppStore } from './store'

/**
 * Subscribes to PI events from the main process and routes them to the store.
 * Must be called once in the top-level component tree.
 */
export function usePiEvents(): void {
  const handlePiEvent = useAppStore((state) => state.handlePiEvent)
  const setPiStatus = useAppStore((state) => state.setPiStatus)

  useEffect(() => {
    // Subscribe to PI events
    const unsubscribeEvent = window.piDesktop.onEvent(handlePiEvent)

    // Subscribe to status changes
    const unsubscribeStatus = window.piDesktop.onStatusChange(setPiStatus)

    return () => {
      unsubscribeEvent()
      unsubscribeStatus()
    }
  }, [handlePiEvent, setPiStatus])
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
 * Loads initial data on mount — workspaces, settings, then PI.
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
      await loadWorkspaces()
      await startPi()
      await refreshSessionState()
      await refreshSessionStats()
      await refreshSessionList()
      await useAppStore.getState().loadTags()
      await useAppStore.getState().loadArchivedSessions()
    }

    initialize()
  }, [startPi, loadSettings, loadWorkspaces, refreshSessionState, refreshSessionStats, refreshSessionList])
}
