import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { matchesShortcut, SHORTCUT_ACTIONS, shortcutProblem, type ShortcutAction } from '../../../shared/keyboard-shortcuts'
import { useAppStore } from '../store'
import { requestCommitPushDialog } from './commit-push-shortcut'

export async function runAppShortcut(action: ShortcutAction): Promise<void> {
  const state = useAppStore.getState()
  switch (action) {
    case 'diff': {
      if (!state.activeWorkspace) return
      const opened = await state.setChatSidePanel('diff')
      if (opened && useAppStore.getState().activeWorkspace?.id === state.activeWorkspace.id) {
        useAppStore.getState().setCurrentView('chat')
      }
      return
    }
    case 'terminal':
      if (state.currentView !== 'chat') {
        state.setCurrentView('chat')
        if (!state.terminalOpen) state.toggleTerminal()
      } else {
        state.toggleTerminal()
      }
      return
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
      requestCommitPushDialog()
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
