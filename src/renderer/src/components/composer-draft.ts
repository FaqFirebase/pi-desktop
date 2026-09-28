/** Prompt-history index while the composer holds the user's own text. */
export const NO_RECALLED_PROMPT = -1

/**
 * The user's in-progress composer text. While prompt-history recall is active
 * the textarea shows a recalled prompt, and the real draft is the text stashed
 * when recall began.
 */
export function composerDraftText(textareaValue: string, historyIndex: number, stashedDraft: string): string {
  return historyIndex === NO_RECALLED_PROMPT ? textareaValue : stashedDraft
}
