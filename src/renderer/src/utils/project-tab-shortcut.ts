export function projectTabShortcutIndex(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'shiftKey' | 'ctrlKey' | 'altKey'>,
  activeIndex: number,
  count: number
): number | null {
  if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey || count === 0) return null

  const next = event.key === ']' || event.key === '}' || event.code === 'BracketRight'
  const previous = event.key === '[' || event.key === '{' || event.code === 'BracketLeft'
  if (!next && !previous) return null
  if (activeIndex < 0) return next ? 0 : count - 1
  return (activeIndex + (next ? 1 : -1) + count) % count
}
