/** What the chat column has to show right now. */
export interface ChatViewContent {
  sessionLoading: boolean
  messageCount: number
  isStreaming: boolean
  /** A council run of this chat is on screen (see councilRunOnScreen). */
  councilOnScreen: boolean
}

/**
 * True when the chat shows the centered start screen. A council run on screen
 * counts as content: its panel sits above the floating composer, so a council
 * started from a new chat must leave the start screen to be seen and stopped.
 */
export function isEmptyChatView(content: ChatViewContent): boolean {
  return !content.sessionLoading
    && content.messageCount === 0
    && !content.isStreaming
    && !content.councilOnScreen
}
