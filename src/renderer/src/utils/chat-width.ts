import type { ChatWidth } from '../../../shared/chat-width'

// Tailwind finds classes by scanning the source text, so every class is
// written out in full here instead of being built from parts.

/** Shared width for messages, composer, and the panels above it. */
const MESSAGE_COLUMN_CLASS: Record<ChatWidth, string> = {
  normal: 'max-w-5xl',
  full: 'max-w-none',
}

export function messageColumnClass(width: ChatWidth): string {
  return MESSAGE_COLUMN_CLASS[width]
}

export function composerColumnClass(width: ChatWidth): string {
  return messageColumnClass(width)
}
