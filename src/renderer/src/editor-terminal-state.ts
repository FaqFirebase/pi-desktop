import { DEFAULT_TERMINAL_SLOT, type TerminalSlot } from '../../shared/terminal-slot'

/**
 * Which workspaces have a terminal editor running in their editor slot, and
 * which slot each workspace's terminal panel shows.
 */
export interface EditorTerminalState {
  editorTerminalWorkspaces: string[]
  shownTerminalSlot: Record<string, TerminalSlot>
}

/** A terminal editor started in `workspaceId`: list it once and show it. */
export function withEditorTerminal(state: EditorTerminalState, workspaceId: string): EditorTerminalState {
  return {
    editorTerminalWorkspaces: state.editorTerminalWorkspaces.includes(workspaceId)
      ? state.editorTerminalWorkspaces
      : [...state.editorTerminalWorkspaces, workspaceId],
    shownTerminalSlot: { ...state.shownTerminalSlot, [workspaceId]: 'editor' },
  }
}

/** The editor in `workspaceId` exited: drop it and show the shell again. */
export function withoutEditorTerminal(state: EditorTerminalState, workspaceId: string): EditorTerminalState {
  return {
    editorTerminalWorkspaces: state.editorTerminalWorkspaces.filter((id) => id !== workspaceId),
    shownTerminalSlot: { ...state.shownTerminalSlot, [workspaceId]: DEFAULT_TERMINAL_SLOT },
  }
}

/** The slot the panel shows; the editor slot only while an editor runs. */
export function shownSlotFor(state: EditorTerminalState, workspaceId: string): TerminalSlot {
  const shown = state.shownTerminalSlot[workspaceId] ?? DEFAULT_TERMINAL_SLOT
  return shown === 'editor' && !state.editorTerminalWorkspaces.includes(workspaceId) ? DEFAULT_TERMINAL_SLOT : shown
}
