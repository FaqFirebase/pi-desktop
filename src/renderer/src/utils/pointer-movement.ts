/**
 * Whether a mouse event comes from the pointer actually moving. Chromium also
 * sends mouse events with no movement when content shifts under a resting
 * pointer (a list re-rendering while the user types). A list that follows the
 * pointer only on real movement keeps the keyboard selection meanwhile.
 */
export function isPointerMovement(event: Pick<MouseEvent, 'movementX' | 'movementY'>): boolean {
  return event.movementX !== 0 || event.movementY !== 0
}
