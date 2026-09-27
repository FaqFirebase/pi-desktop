export function isTerminalShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>
): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
    !event.isComposing && (event.key === '`' || event.code === 'Backquote')
}
