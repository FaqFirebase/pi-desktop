import type { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { EditorGuard } from './editor-guard'

// The app's quit lifecycle as a small module with injected IO. Keeping the
// drain sequence here (instead of inline in index.ts) gives the lifecycle a
// single real implementation that both the production entry and the unit
// harness exercise: quit gating on the editor guard, one shared async drain,
// and the final synchronous teardown. index.ts wires the real app, editor
// guard, services and quick-chat popup into it.

export interface AppShutdownDeps {
  /** The Electron app (or an EventEmitter stand-in with `quit`). */
  app: Pick<EventEmitter, 'on' | 'off' | 'emit'> & { quit(): void }
  /** True once a real quit is in progress (also drives tray/close behavior). */
  isQuitting: () => boolean
  /** Mark the real-quit flag once a quit is confirmed to proceed. */
  setQuitting(value: boolean): void
  /** Decides whether teardown must pause for the unsaved-editor dialog. */
  editorGuard: EditorGuard
  /** Native discard confirmation; resolves true to discard and continue. */
  confirmEditorDiscard(window: BrowserWindow | null): Promise<boolean>
  /** The main window to surface when the discard dialog needs to show it. */
  getMainWindow(): BrowserWindow | null
  /** Close auxiliary windows (quick-chat popup) synchronously on a real quit. */
  destroyAuxWindows(): void
  /** Async drain of workspace services; a throw is logged, not fatal. */
  stopAll(): Promise<void>
  /** Mark a service teardown failure in the log. */
  warnShutdown(error: unknown): void
  /** Synchronous final teardown, run once after the drain completes. */
  finalizeTeardown(): void
}

export interface AppShutdown {
  /** Register the quit handlers. Call once from index.ts. */
  wire(): void
  /** Unregister the handlers. */
  unwire(): void
  /** The real-quit flag, as wired by index.ts. */
  isQuitting(): boolean
}

/**
 * Creates the quit lifecycle handlers bound to injected IO. `before-quit`
 * gates on the unsaved-editor dialog before marking the quit, then destroys
 * auxiliary windows synchronously (the quick-chat popup must not outlive the
 * real quit); `will-quit` runs the async workspace drain exactly once; the
 * final synchronous teardown runs only after the drain completes.
 */
export function createAppShutdown(deps: AppShutdownDeps): AppShutdown {
  let drainStarted = false
  let drainDone = false

  const beforeQuit = (event: { preventDefault(): void }): void => {
    // A real quit is already in progress: the drain-resume re-quit (and any
    // redundant user quit) must not re-mark the flag or re-destroy aux windows.
    // `destroyQuickChatWindow` is idempotent, so this matches production.
    if (deps.isQuitting()) return
    // Gate BEFORE the quit flag is set: quitting destroys the renderer and its
    // unsaved editor buffer, and a cancelled dialog must leave the tray-hide
    // behavior (which reads isQuitting) exactly as it was.
    if (deps.editorGuard.needsPrompt()) {
      event.preventDefault()
      void deps.confirmEditorDiscard(deps.getMainWindow()).then((discard) => {
        if (discard) {
          deps.editorGuard.confirmDiscard()
          deps.app.quit()
        }
      })
      return
    }
    // Mark a real quit so the window `close` handler stops hiding to tray and
    // lets the window actually close. This is the single choke point every
    // quit path flows through (menu/tray Quit, Cmd-Ctrl+Q).
    deps.setQuitting(true)
    deps.destroyAuxWindows()
  }

  const willQuit = (event: { preventDefault(): void }): void => {
    if (drainDone) {
      deps.finalizeTeardown()
      return
    }
    event.preventDefault()
    if (drainStarted) return
    drainStarted = true
    // The executor turns a synchronous stopAll() throw into a rejection, so a
    // failed teardown is logged and the quit still resumes instead of hanging.
    void new Promise<void>((resolve) => resolve(deps.stopAll()))
      .catch((error: unknown) => deps.warnShutdown(error))
      .then(() => {
        drainDone = true
        // Native macOS terminate: is still unwinding during promise microtasks.
        // Resume on the next turn so it cannot swallow the renewed quit request.
        setImmediate(() => deps.app.quit())
      })
  }

  const wire = (): void => {
    deps.app.on('before-quit', beforeQuit)
    deps.app.on('will-quit', willQuit)
  }
  const unwire = (): void => {
    deps.app.off('before-quit', beforeQuit)
    deps.app.off('will-quit', willQuit)
  }
  return {
    wire,
    unwire,
    isQuitting: () => deps.isQuitting(),
  }
}
