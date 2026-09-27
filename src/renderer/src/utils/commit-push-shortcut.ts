export function isCommitPushShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>,
): boolean {
  return event.key.toLowerCase() === 'p' && event.metaKey &&
    !event.ctrlKey && !event.altKey && !event.shiftKey && !event.isComposing
}
