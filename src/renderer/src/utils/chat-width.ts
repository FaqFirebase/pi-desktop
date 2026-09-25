import type { ChatWidth } from '../../../shared/chat-width'

// Tailwind finds classes by scanning the source text, so every class is
// written out in full here instead of being built from parts.

/** Messages and the panels above the composer. */
const MESSAGE_COLUMN_CLASS: Record<ChatWidth, string> = {
  normal: 'max-w-5xl',
  full: 'max-w-none',
}

/** The composer is narrower than the messages in the normal layout. */
const COMPOSER_COLUMN_CLASS: Record<ChatWidth, string> = {
  normal: 'max-w-3xl',
  full: 'max-w-none',
}

export function messageColumnClass(width: ChatWidth): string {
  return MESSAGE_COLUMN_CLASS[width]
}

export function composerColumnClass(width: ChatWidth): string {
  return COMPOSER_COLUMN_CLASS[width]
}
