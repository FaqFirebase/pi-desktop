import { Sidebar } from './components/sidebar'
import { ChatPanel } from './components/chat-panel'
import { StatusBar } from './components/status-bar'
import { SettingsPanel } from './components/settings-panel'
import { SessionPanel } from './components/session-panel'
import { Timeline } from './components/timeline'
import { PackageBrowser } from './components/package-browser'
import { DiffViewer } from './components/diff-viewer'
import { NotesPanel } from './components/notes-panel'
import { NotePicker } from './components/note-picker'
import { ExtensionUiDialog } from './components/extension-ui-dialog'
import { ReviewRail } from './components/review-rail'
import { useContextMenu, buildDefaultContextMenu } from './components/context-menu'
import { usePiEvents, useMenuActions, useInitialize, useNotePickerShortcut } from './hooks'
import { useAppStore } from './store'
import { useEffect } from 'react'

export function App(): React.JSX.Element {
  usePiEvents()
  useMenuActions()
  useInitialize()
  useNotePickerShortcut()

  const currentView = useAppStore((state) => state.currentView)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)

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

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && <Sidebar />}

        <div className="flex min-w-0 flex-1 overflow-hidden">
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {currentView === 'chat' && <ChatPanel />}
            {currentView === 'settings' && <SettingsPanel />}
            {currentView === 'sessions' && <SessionPanel />}
            {currentView === 'timeline' && <Timeline />}
            {currentView === 'packages' && <PackageBrowser />}
            {currentView === 'diff' && <DiffViewer />}
            {currentView === 'notes' && <NotesPanel />}
          </main>
          {currentView === 'chat' && <ReviewRail />}
        </div>
      </div>

      <StatusBar />
      <ExtensionUiDialog />
      <NotePicker />
      {ContextMenuComponent}
    </div>
  )
}
