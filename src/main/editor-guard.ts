// Pure decision logic for guarding the renderer's unsaved editor buffer
// against teardown (quit, window close, reload). Kept free of any `electron`
// import so it can be unit-tested under a plain Node runtime; the dialog and
// menu wiring lives in index.ts. The renderer mirrors its dirty flag here on
// every transition — teardown outruns any renderer-side ask, so the decision
// has to be local to main.

export interface EditorGuard {
  /** Mirror of the renderer's dirty flag; new edits re-arm a confirmed discard. */
  setDirty(dirty: boolean, fileName: string | null): void
  /** Renderer reloaded or crashed: its buffer is gone, nothing left to guard. */
  reset(): void
  /** True when a teardown must pause for the discard confirmation. */
  needsPrompt(): boolean
  /** Record an accepted discard so the resumed teardown is not asked again. */
  confirmDiscard(): void
  /** Dialog text, naming the dirty file when the renderer reported one. */
  promptMessage(): string
}

export function createEditorGuard(): EditorGuard {
  let dirty = false
  let fileName: string | null = null
  let discardConfirmed = false

  return {
    setDirty(nextDirty, nextFileName) {
      dirty = nextDirty
      fileName = nextDirty ? nextFileName : null
      // Fresh edits are a fresh decision, even right after a confirmed discard.
      if (nextDirty) discardConfirmed = false
    },
    reset() {
      dirty = false
      fileName = null
      discardConfirmed = false
    },
    needsPrompt() {
      return dirty && !discardConfirmed
    },
    confirmDiscard() {
      discardConfirmed = true
    },
    promptMessage() {
      return fileName ? `Discard unsaved changes to ${fileName}?` : 'Discard unsaved changes?'
    },
  }
}
