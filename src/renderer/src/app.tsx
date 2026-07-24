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
import { useAppStore } from './store'
import { useEffect } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'

export function App(): React.JSX.Element {
  usePiEvents()
  useMenuActions()
  useInitialize()
  useNotePickerShortcut()

  const currentView = useAppStore((state) => state.currentView)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
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

  // Global command palette launcher (Ctrl/Cmd+K). Opens in insert-at-caret mode
  // so it does not overwrite anything already typed in the composer.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        const state = useAppStore.getState()
        if (state.piStatus === 'running') {
          state.setCommandPalette(true, '', false)
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // The Home/launcher view is a full-screen splash: hide the sidebar, review
  // rail, and status bar so it reads as a standalone landing page.
  const isHome = currentView === 'home'

  const showUpdateBanner = !!updateInfo?.updateAvailable && !updateDismissed

  return (
    <div className="flex h-screen flex-col bg-app text-primary">
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
        {sidebarOpen && !isHome && <Sidebar />}

        <div className="flex min-w-0 flex-1 overflow-hidden">
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

      {!isHome && <StatusBar />}
      <ExtensionUiDialog />
      <AppConfirmDialog />
      <NotePicker />
      <CommandPalette />
      {ContextMenuComponent}
    </div>
  )
}
