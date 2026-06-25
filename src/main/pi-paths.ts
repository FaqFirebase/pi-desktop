import { join } from 'path'

/**
 * Absolute path to Pi's on-disk session store (`~/.pi/agent/sessions`).
 * Centralized so session listing, lineage, and activity aggregation agree.
 */
export function getSessionsRoot(): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return join(homeDir, '.pi', 'agent', 'sessions')
}
