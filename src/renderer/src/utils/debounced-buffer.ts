/**
 * Debounced text buffer for editor input: keystrokes are committed to state
 * only after a quiet period (smoothing per-keystroke re-renders), while the
 * newest text stays reachable synchronously so consumers that must not act on
 * stale state — saving, reverting, switching files — can flush or discard the
 * pending text instead of racing the timer.
 */
export interface DebouncedBuffer {
  /** Record the latest text and (re)start the delay before it commits. */
  push(text: string): void
  /** Commit any pending text immediately; returns it, or null if none. */
  flush(): string | null
  /** Discard any pending text without committing. */
  cancel(): void
}

export function createDebouncedBuffer(
  delayMs: number,
  commit: (text: string) => void
): DebouncedBuffer {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: string | null = null

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    push(text) {
      pending = text
      clear()
      timer = setTimeout(() => {
        timer = null
        if (pending !== null) {
          const text = pending
          pending = null
          commit(text)
        }
      }, delayMs)
    },
    flush() {
      clear()
      if (pending === null) return null
      const text = pending
      pending = null
      commit(text)
      return text
    },
    cancel() {
      clear()
      pending = null
    },
  }
}
