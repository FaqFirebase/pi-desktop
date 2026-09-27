export function sessionTabShortcutIndex(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'shiftKey' | 'ctrlKey' | 'altKey'>,
  activeIndex: number,
  count: number
): number | null {
  if (!event.metaKey || event.shiftKey || event.ctrlKey || event.altKey || count === 0) return null
  if (event.key !== ']' && event.key !== '[') return null
  const next = event.key === ']'
  if (activeIndex < 0) return next ? 0 : count - 1
  return (activeIndex + (next ? 1 : -1) + count) % count
}
