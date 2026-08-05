import { Sidebar } from './components/sidebar'
import { ChatPanel } from './components/chat-panel'
import { StatusBar } from './components/status-bar'
import { SettingsPanel } from './components/settings-panel'
import { SessionPanel } from './components/session-panel'
import { Timeline } from './components/timeline'
import { PackageBrowser } from './components/package-browser'
import { DiffViewer } from './components/diff-viewer'
import { HomeScreen } from './components/home-screen'
import { NotesPanel } from './components/notes-panel'
import { SkillsPanel } from './components/skills-panel'
import { NotePicker } from './components/note-picker'
import { CommandPalette } from './components/command-palette'
import { ExtensionUiDialog, AppConfirmDialog } from './components/extension-ui-dialog'
import { ReviewRail } from './components/review-rail'
import { useContextMenu, buildDefaultContextMenu } from './components/context-menu'
import { usePiEvents, useMenuActions, useInitialize, useNotePickerShortcut } from './hooks'
import { useFolderDrop } from './hooks/use-folder-drop'
import { useAppStore } from './store'
import { useEffect } from 'react'
import { ArrowUpCircle, FolderOpen, PanelLeft, X } from 'lucide-react'

export function App(): React.JSX.Element {
  usePiEvents()
  useMenuActions()
  useInitialize()
  useNotePickerShortcut()
  const { isDraggingFolder } = useFolderDrop()

  const currentView = useAppStore((state) => state.currentView)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const updateInfo = useAppStore((state) => state.updateInfo)
  const updateDismissed = useAppStore((state) => state.updateDismissed)
  const dismissUpdate = useAppStore((state) => state.dismissUpdate)

  // Global context menu
  const { show, ContextMenuComponent } = useContextMenu()

  // Override default right-click globally
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Allow native context menu in input fields when no text is selected
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if (isInput && !window.getSelection()?.toString()) {
        return // Let native context menu handle it
      }

      e.preventDefault()

      // Build context-specific items
      const items = buildDefaultContextMenu()
      show(e as unknown as React.MouseEvent, items)
    }

    document.addEventListener('contextmenu', handleContextMenu)
    return () => document.removeEventListener('contextmenu', handleContextMenu)
  }, [show])

  // Global command palette launcher (Ctrl/Cmd+K). Chosen commands insert at
  // the composer caret, so an open draft is never overwritten. Slash-typing in
  // the composer is handled by ChatInput's inline popup instead.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        const state = useAppStore.getState()
        if (state.piStatus === 'running') {
          state.setCommandPalette(true)
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Home is a full-screen splash (no sidebar/status). Chat keeps chrome; the
  // empty-chat center prompt is the "minimal" launch surface when not opening Home.
  const isHome = currentView === 'home'
  const showChrome = !isHome
  // Chat has its own toolbar toggle; other chrome views need a top-left reopen
  // control when the sidebar is closed (otherwise only the status bar has one).
  const showSidebarReopen = showChrome && !sidebarOpen && currentView !== 'chat'

  const showUpdateBanner = !!updateInfo?.updateAvailable && !updateDismissed

  return (
    <div className="relative flex h-screen flex-col bg-app text-primary">
      {isDraggingFolder && (
        <div
          className="pointer-events-none absolute inset-0 z-[100] flex items-center justify-center bg-app/80 backdrop-blur-sm"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent bg-surface/95 px-10 py-8 shadow-xl shadow-black/40">
            <FolderOpen size={36} className="text-accent" />
            <div className="text-center">
              <div className="text-base font-semibold text-primary">
                Drop folder to open as project
              </div>
              <div className="mt-1 text-sm text-dim">
                A new workspace will be created at that path
              </div>
            </div>
          </div>
        </div>
      )}
      {showUpdateBanner && updateInfo && (
        <div className="flex shrink-0 items-center justify-center gap-3 bg-accent px-4 py-1.5 text-xs text-white">
          <ArrowUpCircle size={14} className="shrink-0" />
          <span>
            Pi Desktop <strong>v{updateInfo.latestVersion}</strong> is available — you&apos;re on v{updateInfo.currentVersion}.
          </span>
          <button
            onClick={() => window.piDesktop.system.openExternal(updateInfo.url)}
            className="rounded bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30 transition-colors"
          >
            Download
          </button>
          <button
            onClick={dismissUpdate}
            className="rounded p-0.5 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
            aria-label="Dismiss update notification"
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && showChrome && <Sidebar />}

        <div className="relative flex min-w-0 flex-1 overflow-hidden">
          {showSidebarReopen && (
            <button
              type="button"
              onClick={toggleSidebar}
              className="absolute left-2 top-2 z-30 rounded-md border border-border-strong bg-surface/95 p-1.5 text-muted shadow-sm backdrop-blur-sm hover:bg-surface-hover hover:text-primary transition-colors"
              title="Show sidebar"
              aria-label="Show sidebar"
            >
              <PanelLeft size={16} />
            </button>
          )}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {currentView === 'home' && <HomeScreen />}
            {/* Kept mounted (just hidden) so the chat scroll position survives
                navigating to another view and back. */}
            <div className={currentView === 'chat' ? 'flex min-w-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
              <ChatPanel />
            </div>
            {currentView === 'settings' && <SettingsPanel />}
            {currentView === 'sessions' && <SessionPanel />}
            {currentView === 'timeline' && <Timeline />}
            {currentView === 'packages' && <PackageBrowser />}
            {currentView === 'diff' && <DiffViewer />}
            {currentView === 'notes' && <NotesPanel />}
            {currentView === 'skills' && <SkillsPanel />}
          </main>
          {currentView === 'chat' && <ReviewRail />}
        </div>
      </div>

      {showChrome && <StatusBar />}
      <ExtensionUiDialog />
      <AppConfirmDialog />
      <NotePicker />
      <CommandPalette />
      {ContextMenuComponent}
    </div>
  )
}
