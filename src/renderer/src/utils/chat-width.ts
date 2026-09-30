import type { ChatWidth } from '../../../shared/chat-width'

// Tailwind finds classes by scanning the source text, so every class is
// written out in full here instead of being built from parts.

/**
 * One column width for messages, the composer, the panels above it, and the
 * empty-chat prompt. Normal is a readable column; Full uses the whole pane.
 */
const MESSAGE_COLUMN_CLASS: Record<ChatWidth, string> = {
  normal: 'max-w-3xl',
  full: 'max-w-none',
}

export function messageColumnClass(width: ChatWidth): string {
  return MESSAGE_COLUMN_CLASS[width]
}
