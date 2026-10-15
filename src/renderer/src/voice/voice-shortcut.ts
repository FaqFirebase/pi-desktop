/**
 * Dictation commands from the keyboard: `hold` and `release` come from the
 * push-to-talk key, `toggle` from the system-wide dictation key. The composer's
 * mic button listens; with no composer on screen a command does nothing.
 */
export type VoiceShortcutCommand = 'hold' | 'release' | 'toggle'

type VoiceShortcutListener = (command: VoiceShortcutCommand) => void

const listeners = new Set<VoiceShortcutListener>()

export function onVoiceShortcut(listener: VoiceShortcutListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitVoiceShortcut(command: VoiceShortcutCommand): void {
  for (const listener of listeners) listener(command)
}
