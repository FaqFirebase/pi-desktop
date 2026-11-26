/**
 * The PTYs a workspace can own: the user's shell, and a terminal editor that
 * "Open in editor" starts beside it.
 */
export const TERMINAL_SLOTS = ['shell', 'editor'] as const

export type TerminalSlot = typeof TERMINAL_SLOTS[number]

export const DEFAULT_TERMINAL_SLOT: TerminalSlot = 'shell'

export const EDITOR_TERMINAL_KEY_SUFFIX = '#editor'

export function isTerminalSlot(value: unknown): value is TerminalSlot {
  return typeof value === 'string' && (TERMINAL_SLOTS as readonly string[]).includes(value)
}

/** The PTY pool key of one slot. The shell keeps the bare workspace id. */
export function terminalKey(workspaceId: string, slot: TerminalSlot): string {
  return slot === 'shell' ? workspaceId : `${workspaceId}${EDITOR_TERMINAL_KEY_SUFFIX}`
}

/** Every pool key a workspace can own. */
export function workspaceTerminalKeys(workspaceId: string): string[] {
  return TERMINAL_SLOTS.map((slot) => terminalKey(workspaceId, slot))
}
