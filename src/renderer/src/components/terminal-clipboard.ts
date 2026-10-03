const WINDOWS_PLATFORM: NodeJS.Platform = 'win32'
const COPY_KEY = 'c'
const PASTE_KEY = 'v'

export type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
>

/** Whether Ctrl+C / Ctrl+V act as Copy / Paste in the terminal on this OS. */
export function usesCtrlClipboardShortcuts(platform: NodeJS.Platform): boolean {
  return platform === WINDOWS_PLATFORM
}

/**
 * Whether xterm must skip a key so the browser runs its native copy or paste.
 * xterm otherwise turns Ctrl+V into ^V and Ctrl+C into ^C. On Windows, Ctrl+V
 * always pastes and Ctrl+C copies only when text is selected, so ^C still
 * interrupts the shell. Other platforms keep their native terminal keys
 * (Ctrl+Shift+V on Linux, Cmd+C / Cmd+V on macOS).
 */
export function isNativeClipboardShortcut(
  event: TerminalKeyEvent,
  platform: NodeJS.Platform,
  hasSelection: boolean
): boolean {
  if (!usesCtrlClipboardShortcuts(platform)) return false
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false
  const key = event.key.toLowerCase()
  if (key === PASTE_KEY) return true
  return key === COPY_KEY && hasSelection
}
