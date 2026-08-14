import type { FileSearchResult, SessionListItem, Workspace } from '../../../shared/ipc-contracts'
import { normalizeModelSearchText } from './model-search'

/**
 * Pure filters for the Ctrl/Cmd+K quick switcher's Workspaces / Sessions /
 * Files sections. Token-AND matching with `_-./:` treated as spaces (the
 * model-picker convention), so "pi gui" matches "pi-desktop-gui".
 */

export const MAX_SESSION_RESULTS = 8
export const MAX_FILE_RESULTS = 8

export interface SwitcherFileItem {
  kind: 'file'
  result: FileSearchResult
}

export interface SwitcherSessionItem {
  kind: 'session'
  session: SessionListItem
}

export interface SwitcherWorkspaceItem {
  kind: 'workspace'
  workspace: Workspace
}

export type SwitcherItem = SwitcherFileItem | SwitcherSessionItem | SwitcherWorkspaceItem

/** Every query token must appear somewhere across the given fields. */
export function matchesTokens(query: string, fields: Array<string | null | undefined>): boolean {
  const tokens = normalizeModelSearchText(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = normalizeModelSearchText(fields.filter(Boolean).join(' '))
  return tokens.every((token) => haystack.includes(token))
}

/** Sessions matching the query; input order (last-modified desc) is kept. */
export function filterSessions(
  sessions: SessionListItem[],
  query: string,
  limit = MAX_SESSION_RESULTS,
): SessionListItem[] {
  return sessions
    .filter((s) => matchesTokens(query, [s.name, s.preview, s.projectName]))
    .slice(0, limit)
}

/** Workspaces matching the query by name or path. */
export function filterWorkspaces(workspaces: Workspace[], query: string): Workspace[] {
  return workspaces.filter((ws) => matchesTokens(query, [ws.name, ws.path]))
}
