import { useEffect, useState } from 'react'
import { isImeComposing, type ComposingKeyEvent } from './ime-composing'

export const ESCAPE_KEY = 'Escape'

export interface ClaimableKeyEvent extends ComposingKeyEvent {
  key: string
  defaultPrevented: boolean
  preventDefault: () => void
}

/**
 * An open surface that closes on Escape wherever the focus is (a modal, a
 * popover, a menu). Open surfaces form a stack: only the most recently opened
 * one claims a press, so one Escape closes one surface, whatever order their
 * key listeners run in.
 */
export type EscapeSurface = symbol

const ESCAPE_SURFACE_DESCRIPTION = 'escape-surface'

/** A new surface, not open yet. */
export function createEscapeSurface(): EscapeSurface {
  return Symbol(ESCAPE_SURFACE_DESCRIPTION)
}

const openEscapeSurfaces: EscapeSurface[] = []

/** Put the surface on top of the stack of open surfaces. */
export function openEscapeSurface(surface: EscapeSurface): void {
  closeEscapeSurface(surface)
  openEscapeSurfaces.push(surface)
}

/** Take the surface off the stack; the surface below it gets the next press. */
export function closeEscapeSurface(surface: EscapeSurface): void {
  const index = openEscapeSurfaces.indexOf(surface)
  if (index !== -1) openEscapeSurfaces.splice(index, 1)
}

/**
 * A surface that closes on Escape (menu, popover, modal, inline editor) must
 * mark the press as consumed: the chat's window-level Escape handler stops
 * the running turn unless the default of the event is already prevented
 * (`isAbortShortcut`). Returns true, after it prevents the default, when the
 * press is an Escape the caller acts on. A press is not claimed when it only
 * cancels an IME composition, when another handler already claimed it, or,
 * for a `surface` of the stack, when that surface is not the top one.
 *
 * Call it with `event.nativeEvent` from React handlers, as for
 * `isImeComposing`.
 */
export function claimEscape(event: ClaimableKeyEvent, surface?: EscapeSurface): boolean {
  if (event.key !== ESCAPE_KEY || event.defaultPrevented || isImeComposing(event)) return false
  if (surface !== undefined && openEscapeSurfaces.at(-1) !== surface) return false
  event.preventDefault()
  return true
}

/**
 * Keeps a surface on the stack of open Escape surfaces while `open`; pass the
 * returned surface to `claimEscape`. The surface stays where it is while the
 * component re-renders, so only opening it again puts it on top.
 */
export function useEscapeSurface(open: boolean): EscapeSurface {
  const [surface] = useState(createEscapeSurface)
  useEffect(() => {
    if (!open) return
    openEscapeSurface(surface)
    return () => closeEscapeSurface(surface)
  }, [open, surface])
  return surface
}
