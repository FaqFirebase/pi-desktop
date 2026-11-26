import type { ExtensionStatuses } from '../../../shared/extension-status'
import { stripAnsi } from './strip-ansi'

/**
 * Status keys pi-subagents sets while subagents run. The composer's subagent
 * strip lists them, so the status bar leaves them out.
 */
export const SUBAGENT_STATUS_KEYS: readonly string[] = ['subagent-slash', 'subagent-slash-text', 'subagents-edit']

const SUBAGENT_STATUS_KEY_SET: ReadonlySet<string> = new Set(SUBAGENT_STATUS_KEYS)

/**
 * One status as one line of plain text: terminal colors removed, and line
 * breaks, tabs and repeated spaces folded into single spaces, as Pi's footer
 * does.
 */
function statusLine(text: string): string {
  return stripAnsi(text).replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim()
}

/** The subagent statuses that are set, in SUBAGENT_STATUS_KEYS order, for the composer strip. */
export function subagentStatusLines(statuses: ExtensionStatuses | undefined): string[] {
  if (!statuses) return []
  return SUBAGENT_STATUS_KEYS.flatMap((key) => (
    Object.hasOwn(statuses, key) && statuses[key] ? [stripAnsi(statuses[key])] : []
  ))
}

export interface StatusBarStatus {
  key: string
  text: string
}

/**
 * Every other status for the status bar, ordered by key like Pi's footer, so
 * an extension that wants to come first can pick a key that sorts first.
 * Entries that are empty once cleaned up are left out.
 */
export function statusBarStatuses(statuses: ExtensionStatuses | undefined): StatusBarStatus[] {
  if (!statuses) return []
  return Object.keys(statuses)
    .filter((key) => !SUBAGENT_STATUS_KEY_SET.has(key))
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, text: statusLine(statuses[key]) }))
    .filter((status) => status.text.length > 0)
}
