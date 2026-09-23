/**
 * How wide the chat column may grow. 'normal' keeps a readable column in the
 * middle of the window; 'full' lets messages and the composer use the whole
 * chat area, for large monitors.
 */
export type ChatWidth = 'normal' | 'full'

export const CHAT_WIDTHS: readonly ChatWidth[] = ['normal', 'full']

export const DEFAULT_CHAT_WIDTH: ChatWidth = 'normal'

export function isChatWidth(value: unknown): value is ChatWidth {
  return typeof value === 'string' && (CHAT_WIDTHS as readonly string[]).includes(value)
}
