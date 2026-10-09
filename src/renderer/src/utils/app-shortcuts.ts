import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import {
  matchesShortcut, releasesShortcut, SHORTCUT_ACTIONS, shortcutProblem, type KeyboardShortcuts, type ShortcutAction,
} from '../../../shared/keyboard-shortcuts'
import type { AppSettings } from '../../../shared/ipc-contracts'
import { useAppStore } from '../store'
import { requestCommitPushDialog } from './commit-push-shortcut'
import { adjacentTabIndex, projectTabs, sessionTabs } from './tab-navigation'
import { emitVoiceShortcut } from '../voice/voice-shortcut'

/** Actions that run once per key press; the voice keys are handled in dispatchAppShortcut. */
type CommandShortcutAction = Exclude<ShortcutAction, 'pushToTalk' | 'globalDictation'>

/** The document listener that gets the key: before the focused element ('capture') or after it ('bubble'). */
type ShortcutListenerPhase = 'capture' | 'bubble'

const SHORTCUT_RECORDER_SELECTOR = '[data-shortcut-recorder]'
// Root elements of the CodeMirror code editor and the xterm terminal.
const CODE_EDITOR_SELECTOR = '.cm-editor'
const TERMINAL_SELECTOR = '.xterm'

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

function targetIsWithin(event: KeyboardEvent, selector: string): boolean {
  return event.target instanceof Element && event.target.closest(selector) !== null
}

/** Ctrl with no other modifier: the keys that xterm can send to the shell as control characters. */
function isPlainCtrlChord(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
}

/**
 * The listener that runs the shortcut `event` matches. In the code editor, the bubble listener
 * for every key, so the editor's own commands (indent, find next, fold) keep their keys. In the
 * terminal, the bubble listener for plain Ctrl chords: xterm sends Ctrl+K, Ctrl+B (the tmux
 * prefix) or Ctrl+[ (Escape) to the shell and stops the event, and lets a chord it has no
 * character for (Ctrl+Comma) bubble on. The terminal toggle never waits, so it closes the
 * terminal from inside it. All other keys, the capture listener.
 */
function shortcutPhase(event: KeyboardEvent, action: ShortcutAction): ShortcutListenerPhase {
  if (targetIsWithin(event, CODE_EDITOR_SELECTOR)) return 'bubble'
  const terminalKey = action !== 'terminal' && isPlainCtrlChord(event) && targetIsWithin(event, TERMINAL_SELECTOR)
  return terminalKey ? 'bubble' : 'capture'
}

/** The one dispatch path of both listeners: each runs only the shortcuts that belong to its phase. */
function dispatchAppShortcut(event: KeyboardEvent, phase: ShortcutListenerPhase): void {
  // Already handled (in the bubble phase, also a key that ran a code editor command), or being recorded.
  if (event.defaultPrevented || targetIsWithin(event, SHORTCUT_RECORDER_SELECTOR)) return
  const state = useAppStore.getState()
  const shortcuts = activeShortcuts(state)
  const platform = window.piDesktop.system.platform
  if (shortcutProblem(shortcuts, platform)) return
  const action = SHORTCUT_ACTIONS.find((candidate) => matchesShortcut(event, shortcuts[candidate], platform))
  // The main process owns the system-wide dictation key.
  if (!action || action === 'globalDictation') return
  if (shortcutPhase(event, action) !== phase) return
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

/** Capture phase: runs before the composer, inputs and dialogs can take the key. */
export function handleAppShortcut(event: KeyboardEvent): void {
  dispatchAppShortcut(event, 'capture')
}

/** Bubble phase: runs a shortcut that waits for the code editor or the terminal, when they leave its key alone. */
export function handleAppShortcutAfterTarget(event: KeyboardEvent): void {
  dispatchAppShortcut(event, 'bubble')
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
