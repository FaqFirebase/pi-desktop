import { shortcutAccelerator } from '../shared/keyboard-shortcuts'

/** The part of Electron's `globalShortcut` this module uses. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/**
 * A single system-wide toggle key. Each action owns its own instance, so
 * rebinding Quick Chat cannot release the dictation key. Electron reports
 * only key presses for system-wide shortcuts, never releases.
 */
export class GlobalDictationShortcut {
  private accelerator: string | null = null
  private binding: string | null = null

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly onPress: () => void,
    private readonly onRegisterFailed: (accelerator: string) => void,
  ) {}

  /** Bind `binding` in place of the current key; null turns the key off. */
  apply(binding: string | null): void {
    this.binding = binding
    const next = binding ? shortcutAccelerator(binding) : null
    if (next === this.accelerator) return
    if (this.accelerator) this.registry.unregister(this.accelerator)
    this.accelerator = null
    if (!next) return
    let registered = false
    try {
      registered = this.registry.register(next, this.onPress)
    } catch {
      // Electron may reject registration when the platform service is unavailable.
    }
    if (registered) this.accelerator = next
    else this.onRegisterFailed(next)
  }

  /**
   * Release the registration for exactly `accelerator` when this instance
   * holds it. When two actions swap keys, the new key each one wants must be
   * free before it registers: registering first would collide with the key the
   * other action still holds, and the later release would never be retried.
   * An unchanged registration is left untouched.
   */
  releaseKey(accelerator: string): void {
    if (this.accelerator !== accelerator) return
    this.registry.unregister(accelerator)
    this.accelerator = null
  }

  getStatus(): { binding: string | null; registered: boolean } {
    return { binding: this.binding, registered: this.accelerator !== null }
  }
}
