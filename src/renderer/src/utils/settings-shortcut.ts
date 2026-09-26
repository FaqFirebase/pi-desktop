export function isSettingsShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>,
  platform: string
): boolean {
  return platform === 'darwin' && event.key === ',' && event.metaKey &&
    !event.ctrlKey && !event.altKey && !event.shiftKey && !event.isComposing
}
