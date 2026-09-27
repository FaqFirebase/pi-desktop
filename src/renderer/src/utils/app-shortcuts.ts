import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { matchesShortcut, SHORTCUT_ACTIONS, shortcutProblem, type ShortcutAction } from '../../../shared/keyboard-shortcuts'
import { useAppStore } from '../store'
import { requestCommitPushDialog } from './commit-push-shortcut'
import { adjacentTabIndex, projectTabs, sessionTabs } from './tab-navigation'

export async function runAppShortcut(action: ShortcutAction): Promise<void> {
  const state = useAppStore.getState()
  switch (action) {
    case 'files':
    case 'diff': {
      const workflowVisible = state.workflowPanelOpen && !state.workflowPanelFilter && state.workflowPanelWorkspaceId === null
      const panelVisible = !workflowVisible && ((action === 'diff' && state.currentView === 'diff') ||
        (state.currentView === 'chat' && state.chatSidePanel === action))
      if (panelVisible) {
        await state.setChatSidePanel(null)
        state.setCurrentView('chat')
        return
      }
      if (!state.activeWorkspace) return
      const opened = await state.setChatSidePanel(action)
      if (opened && useAppStore.getState().activeWorkspace?.id === state.activeWorkspace.id) {
        useAppStore.getState().setWorkflowPanelOpen(false)
        useAppStore.getState().setCurrentView('chat')
      }
      return
    }
    case 'sidebar':
      state.toggleSidebar()
      return
    case 'terminal':
    case 'review': {
      const toggle = action === 'terminal' ? state.toggleTerminal : state.toggleReview
      const open = action === 'terminal' ? state.terminalOpen : state.reviewOpen
      const workflowVisible = state.workflowPanelOpen && !state.workflowPanelFilter && state.workflowPanelWorkspaceId === null
      if (state.currentView !== 'chat' || workflowVisible) {
        state.setWorkflowPanelOpen(false)
        state.setCurrentView('chat')
        if (!open) toggle()
      } else {
        toggle()
      }
      return
    }
    case 'newSession':
      state.setWorkflowPanelOpen(false)
      state.setCurrentView('chat')
      await state.createNewSession()
      return
    case 'previousProject':
    case 'nextProject': {
      const tabs = projectTabs(state.workspaces)
      const index = adjacentTabIndex(tabs.findIndex((tab) => tab.id === state.activeWorkspace?.id), tabs.length,
        action === 'nextProject' ? 'next' : 'previous')
      if (index === null) return
      if (await state.activateWorkspace(tabs[index].id)) {
        useAppStore.getState().setWorkflowPanelOpen(false)
        useAppStore.getState().setCurrentView('chat')
      }
      return
    }
    case 'previousSession':
    case 'nextSession': {
      const tabs = sessionTabs(state.sessionRuntimes, state.activeWorkspace?.id)
      const index = adjacentTabIndex(tabs.findIndex((tab) => tab.runtimeId === state.activeSessionRuntimeId || tab.active), tabs.length,
        action === 'nextSession' ? 'next' : 'previous')
      if (index === null) return
      state.setWorkflowPanelOpen(false)
      state.setCurrentView('chat')
      await state.switchSession(tabs[index].sessionPath!, state.activeWorkspace?.path)
      return
    }
    case 'settings':
      state.setCurrentView('settings')
      return
    case 'commandPalette':
      state.setCommandPalette(true)
      return
    case 'modelSelector':
      state.requestModelSelectorOpen()
      return
    case 'notes':
      state.setNotePickerOpen(!state.notePickerOpen)
      return
    case 'commitPush':
      await requestCommitPushDialog()
  }
}

/** Capture before editors/terminals consume app shortcuts, except while recording a new binding. */
export function handleAppShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[data-shortcut-recorder]'))) return
  const state = useAppStore.getState()
  const shortcuts = state.settingsDraft.shortcuts ?? state.settings?.shortcuts ?? DEFAULT_SETTINGS.shortcuts
  const platform = window.piDesktop.system.platform
  if (shortcutProblem(shortcuts, platform)) return
  const action = SHORTCUT_ACTIONS.find((candidate) => matchesShortcut(event, shortcuts[candidate], platform))
  if (!action) return
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) void runAppShortcut(action)
}
