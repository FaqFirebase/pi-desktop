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

/** The composer text after an insert and where the caret goes. */
export interface ComposerTextEdit {
  value: string
  caret: number
}

/**
 * An insert into the composer: `text` replaces the selection, or the whole
 * box with `replace`. Null for an empty insert (a Browser pane pick adds only
 * attachments), so the user's text and selection stay as they are.
 */
export function composerInsertEdit(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  insert: { text: string; replace?: boolean }
): ComposerTextEdit | null {
  if (insert.replace) return { value: insert.text, caret: insert.text.length }
  if (!insert.text) return null
  return {
    value: value.slice(0, selectionStart) + insert.text + value.slice(selectionEnd),
    caret: selectionStart + insert.text.length,
  }
}
