/**
 * IME composition guard (issue #71).
 *
 * While an input method editor (Japanese, Chinese, Korean, ...) owns the
 * keyboard, Enter confirms the conversion, Escape cancels it and the arrows
 * walk the candidate list. Chromium delivers those presses as ordinary
 * `keydown` events before `compositionend`, so every handler that acts on
 * them must skip the event while a composition is in progress.
 *
 * React's synthetic KeyboardEvent does not expose `isComposing`; call this
 * with `event.nativeEvent` from React handlers.
 */

/** `keyCode` reported for keys the IME is still processing on platforms that omit `isComposing`. */
const IME_PROCESSING_KEY_CODE = 229

export interface ComposingKeyEvent {
  isComposing?: boolean
  keyCode?: number
}

export function isImeComposing(event: ComposingKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === IME_PROCESSING_KEY_CODE
}
