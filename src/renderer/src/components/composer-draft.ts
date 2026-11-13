import type { ComposerDraft } from '../store'

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

export interface SubmittedComposerDraft extends ComposerDraft {
  scopeKey: string
  revision: number
}

/** Consume only the accepted snapshot; edits and newly staged files remain. */
export function consumeSubmittedDraft(
  captured: SubmittedComposerDraft,
  current: SubmittedComposerDraft
): ComposerDraft {
  if (captured.scopeKey !== current.scopeKey) return current
  return {
    text: captured.text === current.text && captured.revision === current.revision ? '' : current.text,
    attachments: current.attachments.filter((attachment) => !captured.attachments.includes(attachment)),
  }
}
