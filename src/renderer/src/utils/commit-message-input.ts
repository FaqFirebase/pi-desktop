export interface CommitMessageInput {
  message: string
  edited: boolean
}

export interface LastCommitMessageSuggestion {
  scope: string
  message: string
}

/** A suggestion describes one workspace and one commit selection (all changes, or the filtered paths). */
export function commitMessageScope(workspaceId: string | undefined, paths: readonly string[] | undefined): string {
  return JSON.stringify([workspaceId ?? null, paths ?? null])
}

/**
 * Reopening the dialog shows the last suggestion for this scope at once;
 * the request made on open confirms it, or replaces it when the diff changed.
 */
export function openCommitMessageInput(last: LastCommitMessageSuggestion | null, scope: string): CommitMessageInput {
  return { message: last && last.scope === scope ? last.message : '', edited: false }
}

/**
 * The suggestion requested when the dialog opens fills only an untouched field;
 * an explicit regenerate is the user asking for new text, so it replaces edits.
 */
export function applyCommitMessageSuggestion<T extends CommitMessageInput>(
  input: T, suggestion: string | null, regenerated: boolean,
): T {
  if (!suggestion || (input.edited && !regenerated)) return input
  return { ...input, message: suggestion, edited: false }
}
