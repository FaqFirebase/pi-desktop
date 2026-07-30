import {
  PLANNING_PREAMBLE_OPENING,
  PLANNING_PREAMBLE_SENTINEL,
} from '../../../shared/session-preview'

/**
 * The preamble is stored verbatim as the session's first user message, so the
 * sentinels are shared with `stripInjectedPreamble` — which uses them to recover
 * the request for a session-list preview.
 */
export function buildPlanningPrompt(userPrompt: string): string {
  return [
    PLANNING_PREAMBLE_OPENING,
    '',
    'Use available read/search/list tools to inspect the workspace and build context, but do not edit files, create files, delete files, run shell commands, install packages, commit, or push.',
    '',
    'Return a step-by-step plan before any implementation. Include:',
    '- Relevant context you found',
    '- Files or areas likely involved',
    '- Proposed changes',
    '- Risks or assumptions',
    '- Verification steps',
    '',
    PLANNING_PREAMBLE_SENTINEL,
    userPrompt,
  ].join('\n')
}
