import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import {
  matchesShortcut, releasesShortcut, SHORTCUT_ACTIONS, shortcutProblem, type KeyboardShortcuts, type ShortcutAction,
} from '../../../shared/keyboard-shortcuts'
import type { AppSettings } from '../../../shared/ipc-contracts'
import { useAppStore } from '../store'
import { requestCommitPushDialog } from './commit-push-shortcut'
import { adjacentTabIndex, projectTabs, sessionTabs } from './tab-navigation'
import { emitVoiceShortcut } from '../voice/voice-shortcut'

/** Actions that run once per key press; the voice keys are handled in handleAppShortcut. */
type CommandShortcutAction = Exclude<ShortcutAction, 'pushToTalk' | 'globalDictation'>

// The push-to-talk binding while its key is held down, so the matching key-up ends it.
let heldPushToTalk: string | null = null

/** The shortcuts in force: the unsaved Settings draft first, then the saved settings, then the defaults. */
export function activeShortcuts(state: { settingsDraft: Partial<AppSettings>; settings: AppSettings | null }): KeyboardShortcuts {
  return state.settingsDraft.shortcuts ?? state.settings?.shortcuts ?? DEFAULT_SETTINGS.shortcuts
}

export async function runAppShortcut(action: CommandShortcutAction): Promise<void> {
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
      const tabs = projectTabs(state.workspaces, state.projectTabOrder)
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
  const shortcuts = activeShortcuts(state)
  const platform = window.piDesktop.system.platform
  if (shortcutProblem(shortcuts, platform)) return
  const action = SHORTCUT_ACTIONS.find((candidate) => matchesShortcut(event, shortcuts[candidate], platform))
  // The main process owns the system-wide dictation key.
  if (!action || action === 'globalDictation') return
  event.preventDefault()
  event.stopPropagation()
  if (event.repeat) return
  if (action === 'pushToTalk') {
    heldPushToTalk = shortcuts.pushToTalk
    emitVoiceShortcut('hold')
    return
  }
  void runAppShortcut(action)
}

/** Letting go of the push-to-talk key or one of its modifiers ends the recording. */
export function handleAppShortcutRelease(event: KeyboardEvent): void {
  if (heldPushToTalk && releasesShortcut(event, heldPushToTalk, window.piDesktop.system.platform)) {
    releasePushToTalk()
  }
}

/** Also called when the window loses focus, because its key-up then never arrives. */
export function releasePushToTalk(): void {
  if (!heldPushToTalk) return
  heldPushToTalk = null
  emitVoiceShortcut('release')
}
