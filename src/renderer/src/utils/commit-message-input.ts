export interface CommitMessageInput {
  message: string
  edited: boolean
}

export interface LastCommitMessageSuggestion {
  scope: string
  message: string
}

/**
 * A suggestion describes one workspace and one commit selection: all changes,
 * or the filtered paths.
 */
export function commitMessageScope(workspaceId: string | undefined, paths: readonly string[] | undefined): string {
  return JSON.stringify([workspaceId ?? null, paths ?? null])
}

/**
 * Reopening the dialog shows the last suggestion for this scope at once,
 * without sending anything; the user clicks Suggest for a fresh one.
 */
export function openCommitMessageInput(last: LastCommitMessageSuggestion | null, scope: string): CommitMessageInput {
  return { message: last && last.scope === scope ? last.message : '', edited: false }
}

/**
 * A suggestion fills the field unless the user typed after clicking Suggest;
 * typed text always wins over a suggestion that arrives later.
 */
export function applyCommitMessageSuggestion<T extends CommitMessageInput>(input: T, suggestion: string | null): T {
  if (!suggestion || input.edited) return input
  return { ...input, message: suggestion, edited: false }
}
