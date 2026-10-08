import { shortcutAccelerator } from '../shared/keyboard-shortcuts'

/** The part of Electron's `globalShortcut` this module uses. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/**
 * The system-wide dictation key. Electron reports only key presses for a
 * system-wide key, never releases, so each press toggles dictation instead of
 * holding it.
 */
export class GlobalDictationShortcut {
  private accelerator: string | null = null

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly onPress: () => void,
    private readonly onRegisterFailed: (accelerator: string) => void,
  ) {}

  /** Bind `binding` in place of the current key; null turns the key off. */
  apply(binding: string | null): void {
    const next = binding ? shortcutAccelerator(binding) : null
    if (next === this.accelerator) return
    if (this.accelerator) this.registry.unregister(this.accelerator)
    this.accelerator = null
    if (!next) return
    if (this.registry.register(next, this.onPress)) this.accelerator = next
    else this.onRegisterFailed(next)
  }
}
